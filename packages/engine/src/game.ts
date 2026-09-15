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
import { executeEffects, type EffectContext } from './effects.js';
import { buildPriorityDecision, castSpell, activateAbility, playLand } from './casting.js';
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
  /** Objects exiled "until this leaves" whose source has left; returned by SBA. */
  pendingReturns: ObjectId[] = [];
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
  *ask(d: DecisionInput): Gen<Response> {
    const decision = { ...d, id: this.state.nextDecisionId++ } as Decision;
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
    if (obj.faceIndex > 0 && s.faces?.[obj.faceIndex - 1]) return s.faces[obj.faceIndex - 1];
    return s;
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
        if (ab.condition && !this.checkCondition(ab.condition, { sourceId: src.id, controller: src.controller })) continue;
        out.push(ab.rule);
      }
    }
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
        if (a) a.attachedTo = null;
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
    // A zone change makes a new object: effects locked onto the old one end (rule 400.7).
    if (fromZone !== toZone) {
      this.state.continuousEffects = this.state.continuousEffects
        .map((ce) => (ce.affected.kind === 'fixed' && ce.affected.ids.includes(id) ? { ...ce, affected: { kind: 'fixed' as const, ids: ce.affected.ids.filter((x) => x !== id) } } : ce))
        .filter((ce) => !(ce.affected.kind === 'fixed' && ce.affected.ids.length === 0));
      const exiled = obj.memory['exiledUntilLeaves'] as ObjectId[] | undefined;
      if (exiled?.length) this.pendingReturns.push(...exiled);
    }
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
      if (toZone === 'exile') this.emit({ name: 'exiled', ...base, playerId: obj.owner });
      if (toZone === 'hand' && fromZone !== 'library') this.emit({ name: 'returnedToHand', ...base, playerId: obj.owner });
      if (toZone === 'battlefield') this.emit({ name: 'entersBattlefield', ...base, playerId: obj.controller });
      if (opts.cause === 'sacrifice') this.emit({ name: 'sacrifice', ...base, playerId: snapshot.controller });
      if (opts.cause === 'discard') this.emit({ name: 'discard', ...base, playerId: obj.owner });
      if (opts.cause === 'mill') this.emit({ name: 'mill', ...base, playerId: obj.owner });
    }

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
  }

  private collectTriggers(event: GameEvent) {
    const lkiCh = (event.data?.lkiCh as Characteristics | undefined) ?? undefined;
    for (const obj of Object.values(this.state.objects)) {
      if (obj.phasedOut) continue;
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
        if (!this.triggerMatches(ab.filter, event, evalObj, controller, lkiCh)) continue;
        if (ab.condition && !this.checkCondition(ab.condition, { sourceId: obj.id, controller, triggerContext: this.triggerContextFrom(event) })) continue;
        if (ab.oncePerTurn) {
          const k = `once:${obj.id}:${ab.text}`;
          if (this.state.turnStats[k]) continue;
          this.state.turnStats[k] = 1;
        }
        this.pendingTriggers.push({ sourceId: obj.id, controller, ability: ab, context: this.triggerContextFrom(event), snapshot: isSelfLeaving ? event.snapshot : undefined });
      }
    }
    // Delayed triggers
    for (const dt of [...this.state.delayedTriggers]) {
      if (dt.event !== event.name) continue;
      const src = this.state.objects[dt.sourceId];
      const evalObj = src ?? (event.snapshot as GameObject);
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
        return cmp(objectsMatching(this, c.filter, { sourceId: ctx.sourceId, controller: ctx.controller, x: ctx.x }).length, c.op, this.resolveAmount(c.value, ectx));
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
      case 'not':
        return !this.checkCondition(c.c, ctx);
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
        return objectsMatching(this, a.filter, fctx).length + (a.plus ?? 0);
      case 'countersOn':
        return this.resolveObjects(a.ref, ctx).reduce((s, o) => s + (o.counters[a.counter] ?? 0), 0);
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
      case 'chosenNumber':
        return (ctx.memory['chosenNumber'] as number) ?? 0;
      case 'differenceLife': {
        const f = this.resolvePlayers(a.from, ctx)[0];
        const t = this.resolvePlayers(a.to, ctx)[0];
        return f && t ? Math.max(0, this.player(f).life - this.player(t).life) : 0;
      }
    }
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
        return objT(objectsMatching(this, ref.filter, { sourceId: ctx.sourceId, controller: ctx.controller, x: ctx.x }).map((o) => o.id));
      case 'iter':
        return ctx.iter ? [ctx.iter] : [];
      case 'lastCreated':
        return objT((ctx.memory['lastCreated'] as ObjectId[]) ?? []);
      case 'lastMoved':
        return objT((ctx.memory['lastMoved'] as ObjectId[]) ?? []);
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
        const v = (src?.memory[ref.key] ?? ctx.memory[ref.key]) as ObjectId[] | PlayerId | undefined;
        if (Array.isArray(v)) return objT(v);
        if (typeof v === 'string') return plT([v]);
        return [];
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
    if (this.state.continuousEffects.length !== before) this.touch();
  }

  // -------------------------------------------------------------------------
  // Player-level primitives
  // -------------------------------------------------------------------------

  drawCards(pid: PlayerId, n: number): ObjectId[] {
    const p = this.player(pid);
    const drawn: ObjectId[] = [];
    for (let i = 0; i < n; i++) {
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
    this.emit({ name: 'lifeGained', playerId: pid, amount, sourceId });
  }

  loseLife(pid: PlayerId, n: number, sourceId?: ObjectId) {
    if (n <= 0) return;
    const p = this.player(pid);
    p.life -= n;
    this.touch();
    this.log(`${p.name} loses ${n} life (${p.life}).`, { kind: 'life', data: { player: pid, delta: -n, life: p.life } });
    this.emit({ name: 'lifeLost', playerId: pid, amount: n, sourceId });
  }

  /** Deal damage from a source to a target (object or player). Handles infect, wither, lifelink, deathtouch, prevention. */
  dealDamage(sourceId: ObjectId | null, target: Target, amount: number, combat: boolean): number {
    if (amount <= 0) return 0;
    const src = sourceId !== null ? this.state.objects[sourceId] : null;
    const sch = src ? this.characteristics(src.id) : null;
    const controller = src?.controller;
    let dealt = amount;
    if (target.kind === 'player') {
      const p = this.player(target.id);
      // Prevention rules on player
      for (const r of this.playerRules(target.id)) if (r.kind === 'damagePrevention') dealt = r.amount === 'all' ? 0 : Math.max(0, dealt - r.amount);
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
      }
      if (sch?.keywords.has('Toxic') && combat) {
        const tox = parseInt(sch.oracleText.match(/Toxic (\d+)/)?.[1] ?? '1', 10);
        p.poison += tox;
      }
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
    this.state.turnStats = {};
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
      // Skip combat steps after declare attackers if nothing attacks.
      if ((step === 'declareBlockers' || step === 'firstStrikeDamage' || step === 'combatDamage') && t.attackers.length === 0) continue;
      if (step === 'firstStrikeDamage' && !this.combatHasFirstStrike()) continue;
      t.step = step;
      t.phase = phase;
      this.touch();
      yield* this.doStep(step);
      // Mana empties between steps.
      for (const p of Object.values(this.state.players)) p.manaPool = emptyPool();
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
          if (o.phasedOut) {
            o.phasedOut = false;
            continue;
          }
          const ch = this.characteristics(id);
          if (ch.rules.some((r) => r.kind === 'cantUntap')) continue;
          if (o.tapped) {
            o.tapped = false;
            this.touch();
          }
        }
        this.log(`${this.player(pid).name} untaps.`);
        // No priority in untap step.
        return;
      }
      case 'upkeep':
        this.emit({ name: 'beginningOfUpkeep', playerId: pid });
        yield* this.priorityRound();
        return;
      case 'draw':
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
    for (;;) {
      // Discard to hand size
      const noMax = this.playerRules(pid).some((r) => r.kind === 'noMaxHandSize');
      const maxHand = 7;
      if (!noMax && p.hand.length > maxHand) {
        const n = p.hand.length - maxHand;
        const resp = yield* this.ask({ type: 'chooseObjects', player: pid, prompt: `Discard ${n} card${n === 1 ? '' : 's'} (hand size)`, candidates: [...p.hand], min: n, max: n, revealToChooser: true });
        if (resp.type === 'objects') for (const id of resp.ids) this.moveObject(id, 'graveyard', { cause: 'discard' });
      }
      // Damage wears off, "until end of turn" ends.
      for (const o of Object.values(this.state.objects)) {
        o.damage = 0;
        o.deathtouchDamage = false;
      }
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
      const nothingToDo = decision.playableCards.length === 0 && decision.activatableAbilities.length === 0 && !decision.canPlayLand;
      let resp: Response;
      if (nothingToDo && this.config.autoPassWhenNothingToDo) {
        resp = { type: 'pass' };
      } else {
        resp = yield* this.ask(decision);
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
