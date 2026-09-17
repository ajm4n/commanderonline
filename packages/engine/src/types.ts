/**
 * Core engine types. The engine is pure and deterministic: given the same
 * seed and the same sequence of player decisions it produces the same game.
 */

export type PlayerId = string;
export type ObjectId = number;

export type Color = 'W' | 'U' | 'B' | 'R' | 'G';
export const COLORS: Color[] = ['W', 'U', 'B', 'R', 'G'];
export type ManaColor = Color | 'C';

export type ZoneName =
  | 'library'
  | 'hand'
  | 'battlefield'
  | 'graveyard'
  | 'stack'
  | 'exile'
  | 'command';

export type CardType =
  | 'Artifact'
  | 'Battle'
  | 'Creature'
  | 'Enchantment'
  | 'Instant'
  | 'Kindred'
  | 'Land'
  | 'Planeswalker'
  | 'Sorcery';

export type Supertype = 'Basic' | 'Legendary' | 'Snow' | 'World';

/** Static card data as printed. Sourced from Scryfall oracle data. */
export interface CardFace {
  name: string;
  manaCost: string; // e.g. "{2}{G}{G}", "" for lands
  typeLine: string; // "Legendary Creature — Elf Druid"
  oracleText: string;
  power?: string; // "2", "*", "1+*"
  toughness?: string;
  loyalty?: string;
  defense?: string;
  colors: Color[];
  imageUri?: string;
}

export type Layout =
  | 'normal'
  | 'split'
  | 'flip'
  | 'transform'
  | 'modal_dfc'
  | 'meld'
  | 'leveler'
  | 'class'
  | 'saga'
  | 'adventure'
  | 'mutate'
  | 'prototype'
  | 'battle'
  | 'planar'
  | 'scheme'
  | 'vanguard'
  | 'token'
  | 'double_faced_token'
  | 'emblem'
  | 'augment'
  | 'host'
  | 'art_series'
  | 'reversible_card'
  | 'case';

export interface CardData extends CardFace {
  oracleId: string;
  scryfallId?: string;
  layout: Layout;
  cmc: number;
  colorIdentity: Color[];
  keywords: string[]; // Scryfall keyword list e.g. ["Flying", "Haste"]
  /** Back / second face for transform, MDFC, adventure, split. */
  faces?: CardFace[];
  /** True for tokens created by effects. */
  isToken?: boolean;
  producedMana?: ManaColor[];
}

export type CounterType = string; // "+1/+1", "-1/-1", "loyalty", "charge", "poison" (players), ...

export interface GameObject {
  id: ObjectId;
  card: CardData;
  /** Which face is currently active (0 = front). */
  faceIndex: number;
  owner: PlayerId;
  controller: PlayerId;
  /** Controller before continuous control-changing effects (layer 2) apply. */
  baseController: PlayerId;
  zone: ZoneName;
  tapped: boolean;
  flipped: boolean;
  faceDown: boolean;
  /** Turn number this object came under its controller's control on the battlefield. */
  controlSinceTurn: number;
  /** Monotonic timestamp: when the object entered its current zone. */
  timestamp: number;
  counters: Record<CounterType, number>;
  damage: number;
  deathtouchDamage: boolean;
  attachedTo: ObjectId | null;
  attachments: ObjectId[];
  /** Soulbond: the creature this one is paired with. */
  pairedWith?: ObjectId | null;
  /** Mutate: the other cards merged into this permanent (it keeps all their abilities). */
  mergedCards?: CardData[];
  isCommander: boolean;
  /** Number of times cast from the command zone (for commander tax). */
  commanderCasts: number;
  /** Whether this permanent attacked / blocked this combat. */
  attacking: PlayerId | ObjectId | null;
  blocking: ObjectId[];
  blockedBy: ObjectId[];
  /** Objects this creature is blocked (even if blockers are removed). */
  wasBlocked: boolean;
  /** Which "phase" the permanent is in for phasing. */
  phasedOut: boolean;
  /** Chosen values remembered on the object (e.g. chosen color, named card). */
  chosen: Record<string, unknown>;
  /** Copy of a card's characteristics if this is a copy (clone effects). */
  copyOf?: CardData;
  /** Did this object enter the battlefield this turn? (for haste / summoning sickness) */
  enteredThisTurn: boolean;
  /** Was this spell cast (vs. put on stack by other means)? */
  wasCast: boolean;
  /** Which zone the spell/permanent came from when cast/entering. */
  castFromZone?: ZoneName;
  /** X value chosen when cast. */
  xValue?: number;
  /** Spell modes chosen when cast (modal spells). */
  modes?: number[];
  /** Whether the spell was kicked / other optional additional costs paid. */
  additionalCostsPaid: string[];
  /** Persistent per-object memory used by scripts (e.g. "exiled cards"). */
  memory: Record<string, unknown>;
  /** Turn on which the card was revealed as a "when you cast" trigger etc. */
  lastKnownInfo?: Partial<GameObject>;
  /** Most recent zone change (for "put there from their library this turn"). */
  lastZoneChange?: { from: ZoneName; turn: number };
}

export interface ManaPool {
  W: number;
  U: number;
  B: number;
  R: number;
  G: number;
  C: number;
}

export function emptyPool(): ManaPool {
  return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
}

export interface Player {
  id: PlayerId;
  name: string;
  life: number;
  poison: number;
  experience: number;
  energy: number;
  manaPool: ManaPool;
  commanderDamage: Record<ObjectId, number>;
  library: ObjectId[];
  hand: ObjectId[];
  graveyard: ObjectId[];
  exile: ObjectId[];
  command: ObjectId[];
  landsPlayedThisTurn: number;
  maxLandsPerTurn: number;
  spellsCastThisTurn: number;
  lost: boolean;
  lossReason?: string;
  mulligansTaken: number;
  keptHand: boolean;
  /** Whether this player has drawn a card from an empty library (SBA loss). */
  attemptedDrawFromEmpty: boolean;
  /** Player-level "flags" for effects like "you can't lose the game". */
  flags: Record<string, unknown>;
  /** Turn-scoped stats used by triggers ("first time each turn"). */
  turnStats: Record<string, number>;
  /** Persistent monarch / initiative etc. */
  designations: string[];
  /** How many times the Ring has tempted this player (0-4 levels of abilities). */
  ringLevel: number;
  /** Dungeon currently being explored, if any. */
  dungeon: { name: string; room: string } | null;
  dungeonsCompleted: number;
}

export type Phase = 'beginning' | 'precombatMain' | 'combat' | 'postcombatMain' | 'ending';
export type Step =
  | 'untap'
  | 'upkeep'
  | 'draw'
  | 'main1'
  | 'beginCombat'
  | 'declareAttackers'
  | 'declareBlockers'
  | 'firstStrikeDamage'
  | 'combatDamage'
  | 'endCombat'
  | 'main2'
  | 'end'
  | 'cleanup';

export interface TurnState {
  number: number;
  activePlayer: PlayerId;
  phase: Phase;
  step: Step;
  /** Extra turns queued as player ids. */
  extraTurns: PlayerId[];
  /** Steps to skip this turn. */
  skipSteps: Step[];
  /** Whether combat damage has happened this combat (for first strike). */
  firstStrikeHappened: boolean;
  /** Attackers declared this combat. */
  attackers: ObjectId[];
}

/** A spell or ability waiting to resolve. */
export interface StackItem {
  id: number;
  kind: 'spell' | 'ability' | 'triggered';
  /** The spell object (for spells) or the source object of the ability. */
  sourceId: ObjectId;
  controller: PlayerId;
  /** Human-readable description of what will happen. */
  text: string;
  /** Which ability index on the card (for activated/triggered). */
  abilityRef?: string;
  targets: Target[];
  /** Object timestamps when targeted; a changed timestamp means the target left its zone (new object). */
  targetStamps?: (number | null)[];
  /** Chosen modes for modal abilities. */
  modes?: number[];
  xValue?: number;
  /** Values captured at trigger time (e.g. the creature that died, damage dealt). */
  triggerContext?: Record<string, unknown>;
  /** Whether the item was countered / fizzled. */
  countered?: boolean;
  /** Copies keep a snapshot of the original card. */
  copiedCard?: CardData;
  /** Mana spent to cast the spell. */
  manaSpent?: ManaPool;
  /** Zone the spell will go to on resolution/countering if not battlefield. */
  resolveToZone?: ZoneName;
  timestamp: number;
}

export type Target =
  | { kind: 'object'; id: ObjectId }
  | { kind: 'player'; id: PlayerId }
  | { kind: 'stackItem'; id: number }
  | { kind: 'none' };

/**
 * A continuous effect currently applying to the game. Applied in layer order
 * when computing an object's characteristics.
 */
export interface ContinuousEffect {
  id: number;
  sourceId: ObjectId | null;
  controller: PlayerId;
  timestamp: number;
  /** Static (from a permanent's ability) or from a resolved spell/ability. */
  fromStatic: boolean;
  /** Which objects it affects: fixed set (locked in at creation) or a filter. */
  affected: { kind: 'fixed'; ids: ObjectId[] } | { kind: 'filter'; filter: ObjectFilter };
  duration: 'permanent' | 'endOfTurn' | 'untilSourceLeaves' | 'untilYourNextTurn' | 'thisTurn' | 'endOfCombat' | 'untilNextUntap' | 'whileSourceTapped' | 'whileYouControlSource';
  modification: Modification;
}

export type Modification =
  | { layer: 4; addTypes?: string[]; removeTypes?: string[]; setTypes?: string[]; addSubtypes?: string[]; /** Add the subtype named by this memory key on the source ("are the chosen type"). */ addSubtypesFromMemory?: string; /** Replace subtypes ("becomes the basic land type of your choice"). */ setSubtypes?: string[]; addSupertypes?: Supertype[] }
  | { layer: 5; setColors?: Color[]; addColors?: Color[]; /** Set the colour stored under this memory key on the source ("~ is the chosen colour"). */ setColorsFromMemory?: string }
  | { layer: 6; addKeywords?: string[]; removeKeywords?: string[]; loseAllAbilities?: boolean; addAbilityText?: string[] }
  | { layer: '7b'; setPower?: number; setToughness?: number; powerAmount?: import('./script.js').Amount; toughnessAmount?: import('./script.js').Amount }
  | { layer: '7c'; power: number; toughness: number; /** Multiply by the number of objects matching ("+1/+1 for each artifact you control"). */ perCount?: ObjectFilter; /** Multiply by an amount ("for each charge counter on ~"). */ perAmount?: import('./script.js').Amount }
  | { layer: '7d'; switchPT: true }
  | { layer: 'control'; controller: PlayerId | 'sourceController' } // layer 2
  | { layer: 'copy'; card: CardData } // layer 1
  | { layer: 'rule'; rule: RuleModification }; // non-characteristic rule changes

export type RuleModification =
  | { kind: 'cantAttack' }
  | { kind: 'cantBlock' }
  | { kind: 'cantBeBlocked' }
  | { kind: 'mustAttack' }
  | { kind: 'mustBlock' }
  | { kind: 'cantUntap' }
  | { kind: 'cantBeTargeted'; by?: 'spells' | 'abilities' | 'opponents'; /** Only spells/abilities matching this ("cannot be the target of Aura spells"). */ filter?: ObjectFilter }
  | { kind: 'extraLandDrop'; count: number }
  | { kind: 'noMaxHandSize' }
  /** "Your maximum hand size is eleven" / "... is reduced by two" */
  | { kind: 'maxHandSize'; value?: number; delta?: number }
  | { kind: 'costReduction'; amount: number; filter?: SpellFilter; /** Reduce by `amount` for each permanent matching this ("spells you cast have affinity for artifacts"). */ per?: ObjectFilter; /** Reduce by `amount` times this amount ("for each +1/+1 counter on ~"). */ perAmount?: import('./script.js').Amount }
  | { kind: 'costIncrease'; amount: number; /** Colored symbols to add instead of generic mana ("White spells you cast cost {W} more to cast"). */ symbols?: string; filter?: SpellFilter }
  | { kind: 'entersTapped' }
  | { kind: 'cantLose' }
  | { kind: 'cantGainLife' }
  | { kind: 'damagePrevention'; amount: number | 'all' }
  | { kind: 'hasteLike' }
  | { kind: 'cantBeBlockedByPowerLE'; power: number }
  | { kind: 'cantBeBlockedByPowerGE'; power: number }
  /** "Creatures with power less than ~'s power can't block it." */
  | { kind: 'cantBeBlockedByPowerLessThanSource' }
  /** "~ can't attack unless defending player controls an Island." */
  | { kind: 'cantAttackUnlessDefenderControls'; filter: ObjectFilter }
  /** "~ can't be blocked by creatures with flying" / "by Walls" */
  | { kind: 'cantBeBlockedBy'; filter: ObjectFilter }
  /** "~ can't be blocked this turn except by Spirits." */
  | { kind: 'cantBeBlockedExceptBy'; filter: ObjectFilter }
  /** "~ can't be blocked except by artifact creatures" */
  | { kind: 'canBeBlockedOnlyBy'; filter: ObjectFilter }
  /** "~ can't block creatures with power 2 or greater" */
  | { kind: 'cantBlockFilter'; filter: ObjectFilter }
  | { kind: 'cantBeBlockedByPowerGreaterThanSource' }
  | { kind: 'maxBlockers'; count: number }
  | { kind: 'custom'; tag: string; data?: unknown };

/** Filters describe which objects an effect / trigger / target applies to. */
export interface ObjectFilter {
  zone?: ZoneName | ZoneName[];
  types?: string[]; // any of these card types
  notTypes?: string[];
  subtypes?: string[]; // any of these subtypes
  notSubtypes?: string[];
  supertypes?: Supertype[];
  colors?: Color[]; // any of these
  colorless?: boolean;
  monocolored?: boolean;
  multicolored?: boolean;
  controller?: 'you' | 'opponent' | 'any' | PlayerId;
  owner?: 'you' | 'opponent' | 'any';
  /** The owner must be one of the players this ref resolves to. */
  ownerRef?: import('./script.js').Ref;
  tapped?: boolean;
  untapped?: boolean;
  isToken?: boolean;
  nonToken?: boolean;
  attacking?: boolean;
  /** Attacked at any point this turn (even if no longer attacking). */
  attackedThisTurn?: boolean;
  /** Dealt damage to the effect's controller this turn. */
  dealtDamageToYouThisTurn?: boolean;
  blocking?: boolean;
  attackingOrBlocking?: boolean;
  other?: boolean; // exclude the source object itself
  self?: boolean; // only the source object
  keywords?: string[]; // has any of these keywords
  withoutKeywords?: string[];
  powerLE?: number | 'X';
  powerGE?: number | 'X';
  toughnessLE?: number;
  toughnessGE?: number;
  cmcLE?: number | 'X';
  cmcGE?: number;
  cmcEQ?: number;
  isCommander?: boolean;
  hasCounter?: CounterType;
  legendary?: boolean;
  nonland?: boolean;
  /** A permanent card/spell (artifact, creature, enchantment, land, planeswalker, battle). */
  permanentCard?: boolean;
  /** The card has an Adventure half. */
  hasAdventure?: boolean;
  /** Shares a creature type with the effect's source. */
  sharesCreatureTypeWithSource?: boolean;
  /** Matches if any of these sub-filters match ("artifact or Human spell"). */
  anyOf?: ObjectFilter[];
  /** Not in this zone / in one of these zones (cost reductions for spells cast from unusual zones). */
  notZone?: ZoneName;
  zoneIn?: ZoneName[];
  /** Toughness greater than power ("creatures with toughness greater than their power"). */
  toughnessGreaterThanPower?: boolean;
  /** Only objects attached to / attached by. */
  attachedToSource?: boolean;
  /** Attached to a permanent matching this ("target Aura attached to a land"). */
  attachedToFilter?: ObjectFilter;
  /** Attached to the object a ref resolves to. */
  attachedToRef?: import('./script.js').Ref;
  /** Was dealt damage this turn by the effect's source ("a creature dealt damage by ~ this turn"). */
  damagedBySource?: boolean;
  /** Creatures blocking the filter's source object ("creatures blocking it"). */
  blockingSource?: boolean;
  /** The creature the filter's source is paired with (soulbond). */
  pairedWithSource?: boolean;
  /** Face-down permanents (morph, manifest). */
  faceDown?: boolean;
  /** At least n counters of a kind ("a creature with three or more level counters on it"). */
  counterAtLeast?: { counter: string; n: number };
  /** No counters of this kind ("a creature that doesn't have a +1/+1 counter on it"). */
  withoutCounter?: string;
  /** Same name as the object this ref resolves to ("all cards with the same name as that spell"). */
  sameNameAs?: import('./script.js').Ref;
  /** Each chosen card must have a different name ("up to four cards with different names"). */
  differentNames?: boolean;
  /** Objects of the color the source chose (memory `color`). */
  chosenColor?: boolean;
  /** Has a custom rule with this tag ("saddled", "goaded"). */
  customRule?: string;
  /** Modified: has a counter, or an Equipment/Aura attached that its controller controls. */
  modified?: boolean;
  nameIs?: string;
  /** Matches the card name stored under this memory key ("cards with the chosen name"). */
  nameIsChosen?: string;
  /** Matches the card type stored under this memory key ("spells of the chosen type"). */
  typeIsChosen?: string;
  historic?: boolean;
  /** Was cast this turn / entered this turn etc. */
  enteredThisTurn?: boolean;
  /** Has any counter of this type (e.g. exiled cards with stash counters). */
  hasAnyCounter?: boolean;
  /** Was put into its current zone from a library this turn (milled). */
  fromLibraryThisTurn?: boolean;
  /** Was put into its current zone this turn. */
  enteredZoneThisTurn?: boolean;
  /** Power + toughness at most this ("total power and toughness 5 or less"). */
  ptSumLE?: number;
  /** Power equal to the greatest power among objects matching the rest of the filter for the same controller. */
  highestPower?: boolean;
  /** Toughness equal to the least toughness among objects matching the rest of the filter for the same controller (bolster). */
  lowestToughness?: boolean;
  /** Must have the creature type stored in the source's memory under this key ("of the chosen type"). */
  chosenSubtypeKey?: string;
  /** Controlled by the player a Ref resolves to ("lands target player controls"); bound to `controller` when the effect runs. */
  controllerRef?: import('./script.js').Ref;
  /** Has damage marked on it ("that was dealt damage this turn"). */
  damaged?: boolean;
  /** Is attached to something ("Aura attached to a creature"). */
  attached?: boolean;
  /** Has something attached ("is equipped" / "is enchanted"). */
  hasAttachment?: 'Equipment' | 'Aura' | 'any';
  /** Became monstrous. */
  monstrous?: boolean;
  /** Mana value at most an amount ("with mana value less than or equal to the number of lands you control"). */
  cmcLEAmount?: import('./script.js').Amount;
  cmcEQAmount?: import('./script.js').Amount;
  /** For spells on the stack: targets an object matching / you ("spell that targets a creature you control"). */
  spellTargets?: ObjectFilter | 'you' | 'opponent';
  custom?: string;
}

export interface SpellFilter extends ObjectFilter {
  /** Spell filters can additionally match by controller of the spell. */
  spellController?: 'you' | 'opponent' | 'any';
}

export interface PlayerFilter {
  who: 'you' | 'opponent' | 'any' | 'each' | 'eachOpponent' | 'controller' | 'owner' | 'target' | 'active' | 'defending';
}

/** Log entry for the game log / replay. */
export interface LogEntry {
  seq: number;
  turn: number;
  text: string;
  /** Which players may see it (undefined = everyone). */
  visibleTo?: PlayerId[];
  /** Structured payload for the client (kind + data). */
  kind?: string;
  data?: Record<string, unknown>;
}

/** Game-level event names used for triggers. */
export type GameEventName =
  | 'entersBattlefield'
  | 'leavesBattlefield'
  | 'dies'
  | 'putIntoGraveyard'
  | 'leftGraveyard'
  | 'attacksUnblocked'
  | 'cycled'
  | 'tappedForMana'
  | 'surveil'
  | 'exiled'
  | 'returnedToHand'
  | 'cast'
  | 'spellResolved'
  | 'abilityActivated'
  | 'countered'
  | 'attacks'
  | 'attacked' // a player/planeswalker was attacked
  | 'blocks'
  | 'becomesBlocked'
  | 'dealsDamage'
  | 'dealsCombatDamage'
  | 'dealtDamage'
  | 'dealtCombatDamageToPlayer'
  | 'lifeGained'
  | 'lifeLost'
  | 'finishedVoting'
  | 'drawCard'
  | 'discard'
  | 'discardBatch'
  | 'sacrifice'
  | 'tapped'
  | 'untapped'
  | 'counterAdded'
  | 'counterRemoved'
  | 'tokenCreated'
  | 'landPlayed'
  | 'mill'
  | 'scry'
  | 'shuffle'
  | 'beginningOfUpkeep'
  | 'beginningOfDraw'
  | 'beginningOfPrecombatMain'
  | 'beginningOfCombat'
  | 'beginningOfDeclareAttackers'
  | 'beginningOfEndStep'
  | 'endOfCombat'
  | 'endOfTurn'
  | 'beginningOfTurn'
  | 'beginningOfPostcombatMain'
  | 'playerLost'
  | 'becomesTarget'
  | 'transformed'
  | 'coinFlipped'
  | 'controlChanged'
  | 'becomesMonarch'
  | 'becomesMonstrous'
  | 'foraged'
  | 'expend'
  | 'exerted'
  | 'takesInitiative'
  | 'ventures'
  | 'dungeonCompleted'
  | 'ringTempted'
  | 'committedCrime'
  | 'rolledDie'
  | 'explored'
  | 'becomesUnattached'
  | 'turnedFaceUp'
  | 'unlockedDoor'
  | 'dayNightChanged'
  | 'searchedLibrary'
  | 'becomesAttached'
  | 'proliferated'
  | 'connived'
  | 'phasedIn'
  | 'crewed'
  | 'plotted'
  | 'clashed'
  | 'gotEnergy'
  | 'mutates'
  /** Not a real game event: state triggers are checked as state-based actions. */
  | 'stateTrigger'
  | 'cleanup';

export interface GameEvent {
  name: GameEventName;
  /** The primary object involved (the creature that died, the spell cast, ...). */
  objectId?: ObjectId;
  /** Secondary object (the source of damage, the attacked planeswalker ...). */
  sourceId?: ObjectId;
  /** Player involved (who drew, who was dealt damage, whose upkeep). */
  playerId?: PlayerId;
  /** Second player (the defending player, controller of the source). */
  otherPlayerId?: PlayerId;
  amount?: number;
  /** Zone moved from / to. */
  fromZone?: ZoneName;
  toZone?: ZoneName;
  counterType?: CounterType;
  combat?: boolean;
  /** Snapshot of the object as it last existed (for dies / leaves triggers). */
  snapshot?: GameObject;
  /** Free-form data. */
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Decisions: the engine runs until it needs a choice from a player.
// ---------------------------------------------------------------------------

export interface DecisionBase {
  id: number;
  player: PlayerId;
  /** Text shown to the player. */
  prompt: string;
  /** Source object providing context, if any. */
  sourceId?: ObjectId;
}

export interface PriorityDecision extends DecisionBase {
  type: 'priority';
  /** Which actions the player can legally take right now. */
  playableCards: ObjectId[];
  activatableAbilities: { objectId: ObjectId; abilityIndex: number; text: string }[];
  /** Alternative ways to cast a playable card (warp, evoke, ...). */
  alternativeCosts: { objectId: ObjectId; id: string; label: string }[];
  canPlayLand: boolean;
}

export interface ChooseTargetsDecision extends DecisionBase {
  type: 'chooseTargets';
  /** Legal targets per target slot. */
  slots: { description: string; legal: Target[]; min: number; max: number }[];
}

export interface YesNoDecision extends DecisionBase {
  type: 'yesNo';
  yesLabel?: string;
  noLabel?: string;
}

export interface ChooseOptionDecision extends DecisionBase {
  type: 'chooseOption';
  options: { id: string; label: string; disabled?: boolean }[];
  min: number;
  max: number;
}

export interface ChooseObjectsDecision extends DecisionBase {
  type: 'chooseObjects';
  /** Candidate objects (hidden zones included; the client renders what it can). */
  candidates: ObjectId[];
  min: number;
  max: number;
  /** If true, candidates come from a hidden zone and the choosing player may see them. */
  revealToChooser?: boolean;
}

export interface OrderObjectsDecision extends DecisionBase {
  type: 'orderObjects';
  objectIds: ObjectId[];
  /** Ordering triggers on the stack, cards on top of library, etc. */
  context: 'triggers' | 'libraryTop' | 'graveyard' | 'blockers' | 'damageAssignment';
  items?: { id: number; text: string }[];
}

export interface DeclareAttackersDecision extends DecisionBase {
  type: 'declareAttackers';
  /** Creatures that can attack and who they could attack. */
  candidates: { id: ObjectId; canAttack: (PlayerId | ObjectId)[]; mustAttack: boolean }[];
}

export interface DeclareBlockersDecision extends DecisionBase {
  type: 'declareBlockers';
  attackers: ObjectId[];
  candidates: { id: ObjectId; canBlock: ObjectId[] }[];
}

export interface PayManaDecision extends DecisionBase {
  type: 'payMana';
  cost: string;
  /** Suggested auto-payment: object ids to tap, in order, plus pool mana to use. */
  suggestion: { tap: ObjectId[]; fromPool: ManaPool } | null;
  /** All untapped mana sources the player controls. */
  sources: { id: ObjectId; produces: ManaColor[][] }[];
}

export interface ChooseNumberDecision extends DecisionBase {
  type: 'chooseNumber';
  min: number;
  max: number;
}

export interface MulliganDecision extends DecisionBase {
  type: 'mulligan';
  hand: ObjectId[];
  mulligansTaken: number;
}

export interface DistributeDecision extends DecisionBase {
  type: 'distribute';
  /** Total amount (damage, counters) to split among targets. */
  amount: number;
  targets: Target[];
  minPer: number;
}

export interface ManualTriggerDecision extends DecisionBase {
  type: 'manualTrigger';
  /** An unscripted card's trigger the engine detected from oracle text. */
  text: string;
  objectId: ObjectId;
}

export type Decision =
  | PriorityDecision
  | ChooseTargetsDecision
  | YesNoDecision
  | ChooseOptionDecision
  | ChooseObjectsDecision
  | OrderObjectsDecision
  | DeclareAttackersDecision
  | DeclareBlockersDecision
  | PayManaDecision
  | ChooseNumberDecision
  | MulliganDecision
  | DistributeDecision
  | ManualTriggerDecision;

export type DecisionType = Decision['type'];

/** Player responses to decisions. */
export type Response =
  | { type: 'pass' }
  | { type: 'playLand'; objectId: ObjectId }
  | { type: 'cast'; objectId: ObjectId; faceIndex?: number; xValue?: number; modes?: number[]; alternativeCost?: string; manualMana?: boolean }
  | { type: 'activate'; objectId: ObjectId; abilityIndex: number; xValue?: number; modes?: number[] }
  | { type: 'targets'; targets: Target[][] }
  | { type: 'yesNo'; value: boolean }
  | { type: 'options'; ids: string[] }
  | { type: 'objects'; ids: ObjectId[] }
  | { type: 'order'; ids: number[] }
  | { type: 'attackers'; attacks: { attacker: ObjectId; target: PlayerId | ObjectId }[] }
  | { type: 'blockers'; blocks: { blocker: ObjectId; attacker: ObjectId }[] }
  | { type: 'payMana'; tap: ObjectId[]; fromPool?: Partial<ManaPool>; auto?: boolean }
  | { type: 'number'; value: number }
  | { type: 'mulligan'; keep: boolean; bottom?: ObjectId[] }
  | { type: 'distribute'; amounts: number[] }
  | { type: 'manualDone' }
  | { type: 'cancel' }
  // Manual-mode escape hatches: anything the rules engine cannot automate yet.
  | { type: 'manual'; action: ManualAction };

/**
 * Manual actions let players resolve unscripted cards by hand, Untap-style.
 * They bypass rules enforcement but keep the game state consistent.
 */
export type ManualAction =
  | { kind: 'moveObject'; objectId: ObjectId; toZone: ZoneName; position?: 'top' | 'bottom' | number; tapped?: boolean }
  | { kind: 'tap'; objectId: ObjectId; tapped: boolean }
  | { kind: 'setLife'; playerId: PlayerId; life: number }
  | { kind: 'adjustLife'; playerId: PlayerId; delta: number }
  | { kind: 'addCounters'; objectId: ObjectId; counterType: CounterType; delta: number }
  | { kind: 'createToken'; name: string; typeLine?: string; power?: string; toughness?: string; colors?: Color[]; oracleText?: string; count?: number; tapped?: boolean }
  | { kind: 'addMana'; color: ManaColor; amount: number }
  | { kind: 'draw'; count: number }
  | { kind: 'mill'; count: number }
  | { kind: 'shuffle' }
  | { kind: 'damage'; objectId: ObjectId; amount: number }
  | { kind: 'setControl'; objectId: ObjectId; controller: PlayerId }
  | { kind: 'attach'; objectId: ObjectId; to: ObjectId | null }
  | { kind: 'reveal'; objectId: ObjectId }
  | { kind: 'setMemory'; objectId: ObjectId; key: string; value: unknown }
  | { kind: 'transform'; objectId: ObjectId }
  | { kind: 'concede' }
  | { kind: 'poison'; playerId: PlayerId; delta: number }
  | { kind: 'commanderDamage'; playerId: PlayerId; commanderId: ObjectId; delta: number };

export interface GameConfig {
  seed: number;
  startingLife: number;
  startingHandSize: number;
  /** Free mulligan (Commander) */
  freeMulligan: boolean;
  /** Commander damage rule threshold */
  commanderDamageThreshold: number;
  format: 'commander' | 'brawl' | 'standard-ish';
  /** Whether to auto-pass priority when a player has nothing to do (huge UX win). */
  autoPassWhenNothingToDo: boolean;
  /** Auto-yield: skip priority for players who have no instant-speed plays. */
  smartStops: boolean;
}

export const DEFAULT_CONFIG: GameConfig = {
  seed: 1,
  startingLife: 40,
  startingHandSize: 7,
  freeMulligan: true,
  commanderDamageThreshold: 21,
  format: 'commander',
  autoPassWhenNothingToDo: true,
  smartStops: true,
};

export interface DeckList {
  /** Oracle ids or names; resolved to CardData by the caller. */
  commanders: CardData[];
  mainboard: CardData[];
}

export interface PlayerSetup {
  id: PlayerId;
  name: string;
  deck: DeckList;
}
