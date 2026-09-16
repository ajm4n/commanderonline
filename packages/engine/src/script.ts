/**
 * The card script DSL. A CardScript is a declarative description of what a
 * card does, written either by hand or produced by the oracle-text compiler.
 * The engine interprets scripts; it never runs card-specific code.
 */
import type { Color, CounterType, GameEventName, ManaColor, Modification, ObjectFilter, RuleModification, ZoneName, PlayerId } from './types.js';

// ---------------------------------------------------------------------------
// Amounts and references
// ---------------------------------------------------------------------------

export type Amount =
  | number
  | 'X'
  | { kind: 'count'; filter: ObjectFilter; plus?: number }
  | { kind: 'countersOn'; ref: Ref; counter: CounterType }
  | { kind: 'power'; ref: Ref }
  | { kind: 'toughness'; ref: Ref }
  | { kind: 'manaValue'; ref: Ref }
  | { kind: 'life'; ref: Ref }
  | { kind: 'handSize'; ref: Ref }
  | { kind: 'graveyardSize'; ref: Ref; filter?: ObjectFilter }
  | { kind: 'triggerAmount' } // damage dealt / life gained / etc. captured by trigger
  | { kind: 'devotion'; colors: Color[] }
  | { kind: 'landsYouControl' }
  | { kind: 'opponents' }
  | { kind: 'commanderTax' }
  | { kind: 'cardsDrawnThisTurn' }
  | { kind: 'spellsCastThisTurn' }
  | { kind: 'turnStat'; key: string }
  | { kind: 'memory'; key: string }
  | { kind: 'sum'; parts: Amount[] }
  | { kind: 'times'; a: Amount; b: Amount }
  | { kind: 'max'; a: Amount; b: Amount }
  | { kind: 'chosenNumber' }
  | { kind: 'differenceLife'; from: Ref; to: Ref }
  | { kind: 'ctxMemory'; key: string }
  | { kind: 'half'; a: Amount; round?: 'up' | 'down' }
  | { kind: 'librarySize'; ref: Ref }
  /** Number of objects a Ref resolves to (optionally filtered), e.g. "creature cards milled this way". */
  | { kind: 'countRef'; ref: Ref; filter?: ObjectFilter }
  /** Cards the given player discarded by the current effect. */
  | { kind: 'discardedThisWay'; ref: Ref }
  /** Sum of power of matching objects ("creatures you control have total power 8 or greater"). */
  | { kind: 'totalPower'; filter: ObjectFilter }
  /** "the greatest power among creatures you control" */
  | { kind: 'maxOf'; stat: 'power' | 'toughness' | 'manaValue'; filter: ObjectFilter }
  /** Number of party roles (Cleric, Rogue, Warrior, Wizard) among creatures you control. */
  | { kind: 'partySize' }
  /** Times the spell was kicked (multikicker). */
  | { kind: 'kickCount' }
  /** Number of events of a kind this turn ("creatures that died this turn", "spells your opponents cast this turn"). */
  | { kind: 'eventsThisTurn'; event: GameEventName; player?: 'you' | 'opponent' | 'any' }
  /** Sum of mana values of matching objects. */
  | { kind: 'totalManaValue'; filter: ObjectFilter };

export type Ref =
  | { ref: 'target'; slot?: number }
  | { ref: 'self' }
  | { ref: 'controller' }
  | { ref: 'owner' }
  | { ref: 'eachOpponent' }
  | { ref: 'eachPlayer' }
  | { ref: 'triggerObject' }
  | { ref: 'triggerPlayer' }
  | { ref: 'triggerSource' }
  | { ref: 'triggerController' } // controller of the trigger object
  | { ref: 'attachedTo' }
  | { ref: 'attachments' }
  | { ref: 'all'; filter: ObjectFilter }
  | { ref: 'iter' }
  | { ref: 'lastCreated' }
  | { ref: 'lastMoved' }
  | { ref: 'defendingPlayer' }
  | { ref: 'activePlayer' }
  | { ref: 'chosen'; key: string }
  | { ref: 'stackTarget' } // the spell targeted (for counterspells)
  | { ref: 'controllerOf'; of: Ref }
  | { ref: 'ownerOf'; of: Ref }
  | { ref: 'blockersOf'; of: Ref }
  | { ref: 'ringBearer' }
  | { ref: 'player'; id: PlayerId };

export const R = {
  target: (slot = 0): Ref => ({ ref: 'target', slot }),
  self: { ref: 'self' } as Ref,
  controller: { ref: 'controller' } as Ref,
  eachOpponent: { ref: 'eachOpponent' } as Ref,
  eachPlayer: { ref: 'eachPlayer' } as Ref,
  triggerObject: { ref: 'triggerObject' } as Ref,
  triggerPlayer: { ref: 'triggerPlayer' } as Ref,
  triggerSource: { ref: 'triggerSource' } as Ref,
  attachedTo: { ref: 'attachedTo' } as Ref,
  iter: { ref: 'iter' } as Ref,
  all: (filter: ObjectFilter): Ref => ({ ref: 'all', filter }),
};

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface TokenSpec {
  name: string;
  typeLine: string;
  power?: string;
  toughness?: string;
  colors: Color[];
  oracleText?: string;
  keywords?: string[];
  /** Predefined token ids ("Treasure", "Food", ...) resolved by the engine. */
  preset?: string;
  legendary?: boolean;
  /** Copy of another object (for "create a token that's a copy of ~"). */
  copyOf?: Ref;
  exceptions?: { keywords?: string[]; haste?: boolean; addSubtypes?: string[]; addTypes?: string[]; notLegendary?: boolean; legendary?: boolean; power?: string; toughness?: string; colors?: Color[] };
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export type Comparison = '>=' | '<=' | '==' | '>' | '<' | '!=';

export type Condition =
  | { kind: 'count'; filter: ObjectFilter; op: Comparison; value: Amount }
  | { kind: 'life'; ref: Ref; op: Comparison; value: Amount }
  | { kind: 'yourTurn' }
  | { kind: 'notYourTurn' }
  | { kind: 'handSize'; ref: Ref; op: Comparison; value: Amount }
  | { kind: 'graveyard'; ref: Ref; op: Comparison; value: Amount; filter?: ObjectFilter }
  | { kind: 'objectMatches'; ref: Ref; filter: ObjectFilter }
  | { kind: 'hasCounter'; ref: Ref; counter: CounterType; op?: Comparison; value?: Amount }
  | { kind: 'isTapped'; ref: Ref }
  | { kind: 'isAttacking'; ref: Ref }
  | { kind: 'isMonarch'; ref: Ref }
  | { kind: 'castFrom'; zone: ZoneName }
  | { kind: 'wasKicked' }
  | { kind: 'modeChosen'; mode: number }
  | { kind: 'amount'; a: Amount; op: Comparison; b: Amount }
  | { kind: 'memoryFlag'; key: string }
  | { kind: 'turnStat'; key: string; op: Comparison; value: number }
  | { kind: 'controlsCommander' }
  | { kind: 'commanderOnBattlefield' }
  | { kind: 'inZone'; ref: Ref; zone: ZoneName }
  | { kind: 'playerStat'; stat: 'ringLevel' | 'dungeonsCompleted' | 'poison' | 'experience' | 'energy'; ref?: Ref; op: Comparison; value: Amount }
  | { kind: 'hasInitiative'; ref?: Ref }
  | { kind: 'eventThisTurn'; event: GameEventName; player?: 'you' | 'opponent' | 'any'; who?: Ref; op?: Comparison; value?: number }
  | { kind: 'not'; c: Condition }
  /** The current step/phase ("Activate only during your upkeep"). */
  | { kind: 'turnStep'; steps: string[]; player?: 'you' | 'opponent' | 'any'; beforeAttackers?: boolean }
  | { kind: 'and'; cs: Condition[] }
  | { kind: 'or'; cs: Condition[] }
  | { kind: 'manual'; text: string }; // engine asks the controller yes/no

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export interface TargetSpec {
  description: string;
  /** any = creature, player, planeswalker or battle */
  kind: 'object' | 'player' | 'any' | 'spell' | 'objectOrPlayer' | 'activatedOrTriggered';
  filter?: ObjectFilter;
  playerFilter?: 'any' | 'opponent' | 'you' | 'notController';
  min?: number; // default 1
  max?: number; // default 1
  /** Different targets from other slots. */
  distinct?: boolean;
  /** Only choose targets when a condition applies; otherwise skip. */
  optional?: boolean;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export type Duration = 'endOfTurn' | 'permanent' | 'untilSourceLeaves' | 'untilYourNextTurn' | 'endOfCombat' | 'untilNextUntap' | 'whileSourceTapped' | 'whileYouControlSource';

export type Effect =
  | { kind: 'draw'; amount: Amount; who?: Ref }
  | { kind: 'gainLife'; amount: Amount; who?: Ref }
  | { kind: 'loseLife'; amount: Amount; who?: Ref }
  | { kind: 'setLife'; amount: Amount; who?: Ref }
  | { kind: 'damage'; amount: Amount; to: Ref; source?: Ref; divided?: boolean }
  | { kind: 'destroy'; what: Ref; cantRegenerate?: boolean }
  | { kind: 'exile'; what: Ref; untilSourceLeaves?: boolean; remember?: string; counters?: { counter: CounterType; amount: Amount } }
  | { kind: 'sacrifice'; what: Ref }
  | { kind: 'sacrificeChoice'; who: Ref; filter: ObjectFilter; count: Amount; unlessAlso?: never }
  | { kind: 'returnToHand'; what: Ref }
  | { kind: 'returnToBattlefield'; what: Ref; tapped?: boolean; controller?: 'you' | 'owner'; counters?: { counter: CounterType; amount: Amount }; transformed?: boolean; /** "tapped and attacking" */ attacking?: boolean }
  | { kind: 'putOnLibrary'; what: Ref; position: 'top' | 'bottom' | 'secondFromTop' }
  | { kind: 'moveToZone'; what: Ref; zone: ZoneName; position?: 'top' | 'bottom' }
  | { kind: 'createToken'; token: TokenSpec; count: Amount; tapped?: boolean; attacking?: boolean; who?: Ref; /** Role tokens: attach the created Aura to this object. */ attachTo?: Ref }
  | { kind: 'addCounters'; counter: CounterType; amount: Amount; on: Ref; /** "Distribute N counters among ..." */ divided?: boolean ; /** "your choice of a +1/+1, first strike, or trample counter" */ counterOptions?: string[] }
  | { kind: 'removeCounters'; counter: CounterType; amount: Amount | 'all'; on: Ref }
  | { kind: 'pump'; power: Amount; toughness: Amount; on: Ref; duration?: Duration }
  | { kind: 'setPT'; power: Amount; toughness: Amount; on: Ref; duration?: Duration }
  | { kind: 'grantKeywords'; keywords: string[]; on: Ref; duration?: Duration }
  | { kind: 'removeKeywords'; keywords: string[]; on: Ref; duration?: Duration }
  | { kind: 'loseAllAbilities'; on: Ref; duration?: Duration }
  | { kind: 'addTypes'; types: string[]; on: Ref; duration?: Duration; subtypes?: string[] }
  | { kind: 'setColors'; colors: Color[]; on: Ref; duration?: Duration }
  | { kind: 'applyRule'; rule: RuleModification; on: Ref; duration?: Duration }
  | { kind: 'tap'; what: Ref }
  | { kind: 'untap'; what: Ref }
  | { kind: 'scry'; amount: Amount; who?: Ref }
  | { kind: 'surveil'; amount: Amount; who?: Ref }
  | { kind: 'mill'; amount: Amount; who?: Ref }
  | { kind: 'discard'; amount: Amount | 'hand'; who?: Ref; random?: boolean; chooser?: 'self' | 'controller'; /** With amount 'hand': only cards matching ("discards all nonland cards"). */ filter?: ObjectFilter }
  | { kind: 'addMana'; mana: ManaColor[] | 'anyColor' | 'anyOneColor' | 'commanderColors' | 'chosenColor' | 'triggerMana'; amount?: Amount; who?: Ref }
  | { kind: 'counterSpell'; what: Ref; unlessPays?: string; exileInstead?: boolean }
  | { kind: 'searchLibrary'; who?: Ref; filter: ObjectFilter; count: Amount; destination: 'hand' | 'battlefield' | 'top' | 'graveyard' | 'exile'; tapped?: boolean; reveal?: boolean; shuffle?: boolean; /** "search your library and/or graveyard" */ zones?: ('library' | 'graveyard')[] }
  | { kind: 'shuffle'; who?: Ref }
  | { kind: 'gainControl'; what: Ref; duration?: Duration; who?: Ref }
  | { kind: 'exchangeControl'; a: Ref; b: Ref }
  | { kind: 'copySpell'; what: Ref; count?: Amount }
  | { kind: 'fight'; a: Ref; b: Ref }
  | { kind: 'bite'; a: Ref; b: Ref } // a deals damage equal to its power to b
  | { kind: 'attach'; what: Ref; to: Ref }
  | { kind: 'transform'; what: Ref }
  | { kind: 'flipCoin'; win: Effect[]; lose?: Effect[] }
  | { kind: 'extraTurn'; who?: Ref }
  | { kind: 'extraCombat' }
  | { kind: 'winGame'; who?: Ref }
  | { kind: 'loseGame'; who?: Ref }
  | { kind: 'proliferate' }
  | { kind: 'populate' }
  | { kind: 'becomeMonarch'; who?: Ref }
  | { kind: 'goad'; what: Ref }
  | { kind: 'regenerate'; what: Ref }
  | { kind: 'preventDamage'; amount: Amount | 'all'; to: Ref; duration?: Duration }
  | { kind: 'lookAtTop'; amount: Amount; who?: Ref; then: 'handRestBottom' | 'handRestGraveyard' | 'battlefieldRestBottom' | 'reorder' | 'topRestGraveyard' | 'graveyardRestTop' | 'handRestTop'; filter?: ObjectFilter; pick?: Amount }
  | { kind: 'revealTop'; who?: Ref; ifMatches?: ObjectFilter; then?: Effect[]; else?: Effect[]; destination?: 'hand' | 'graveyard' | 'bottom' | 'stay' }
  | { kind: 'castWithoutPaying'; what: Ref; exileAfter?: boolean }
  | { kind: 'castFrom'; what: Ref; anyManaType?: boolean; free?: boolean; exileAfter?: boolean }
  | { kind: 'playFromExile'; what: Ref; duration?: 'thisTurn' | 'permanent' }
  | { kind: 'chooseColor'; key: string }
  | { kind: 'chooseCreatureType'; key: string }
  | { kind: 'nameCard'; key: string }
  | { kind: 'setMemory'; key: string; value: unknown }
  | { kind: 'incrementMemory'; key: string; by?: number }
  | { kind: 'conditional'; if: Condition; then: Effect[]; else?: Effect[] }
  | { kind: 'forEach'; over: Ref; effects: Effect[] }
  | { kind: 'repeat'; times: Amount; effects: Effect[] }
  | { kind: 'may'; effects: Effect[]; prompt?: string; who?: Ref }
  | { kind: 'unlessPays'; who: Ref; cost: string | { discard: number; random?: boolean; filter?: ObjectFilter } | { sacrifice: ObjectFilter } | { payLife: number } | { returnToHand: ObjectFilter; count: number }; effects: Effect[]; text?: string }
  | { kind: 'ifPays'; who?: Ref; cost: string; effects: Effect[]; text?: string; payLife?: number; energy?: number }
  | { kind: 'exileTop'; amount: Amount; who?: Ref; faceDown?: boolean }
  | { kind: 'revealHand'; who: Ref }
  | { kind: 'chooseObjects'; who?: Ref; filter: ObjectFilter; count: Amount; key: string; upTo?: boolean; owner?: Ref; /** Restrict candidates to the objects of a Ref (a previously chosen set). */ from?: Ref }
  | { kind: 'discardObjects'; what: Ref }
  | { kind: 'ringTempts'; who?: Ref }
  | { kind: 'takeInitiative'; who?: Ref }
  | { kind: 'chooseMode'; options: { text: string; effects: Effect[] }[]; count?: number }
  | { kind: 'delayedTrigger'; event: GameEventName; effects: Effect[]; text: string; once?: boolean; filter?: TriggerFilter; /** "Until end of turn, whenever X, Y": fires repeatedly this turn, then goes away. */ untilEndOfTurn?: boolean }
  | { kind: 'log'; text: string }
  | { kind: 'ventureIntoDungeon' }
  | { kind: 'investigate'; count?: Amount }
  | { kind: 'treasure'; count?: Amount }
  | { kind: 'rollDie'; sides: number; results: { min: number; max: number; effects: Effect[] }[] }
  | { kind: 'phaseOut'; what: Ref }
  | { kind: 'putIntoHand'; what: Ref }
  | { kind: 'dealsDamageEqualToPower'; source: Ref; to: Ref }
  | { kind: 'exchangeLife'; a: Ref; b: Ref }
  | { kind: 'skipTurn'; who: Ref }
  | { kind: 'monstrosity'; amount: Amount }
  | { kind: 'plot' }
  /** Move every card of a player's zone somewhere else ("exile target player's graveyard"). */
  | { kind: 'moveAll'; who: Ref; from: ZoneName; to: ZoneName }
  /** Choose a player and remember them under `key` (readable as { ref: 'chosen', key }). */
  | { kind: 'choosePlayer'; key: string; who: 'opponent' | 'any' }
  /** Grant rules text ("gains 'When this creature dies, ...'"). */
  | { kind: 'grantAbility'; text: string; on: Ref; duration?: Duration }
  | { kind: 'switchPT'; on: Ref; duration?: Duration }
  | { kind: 'extraLandThisTurn'; who?: Ref }
  /** "You get an emblem with '...'" */
  | { kind: 'emblem'; text: string; who?: Ref }
  /** Discover N / cascade: exile from the top until a nonland card with mana value <= N; cast it free or put it in hand. */
  | { kind: 'discover'; amount: Amount }
  /** Turn-wide flags such as "Damage can't be prevented this turn". */
  | { kind: 'turnFlag'; flag: 'noPrevention' | 'keepMana' }
  /** Fog effects: "Prevent all (combat) damage that would be dealt this turn [by X] [to Y]". */
  /** Clash with an opponent: each reveals the top card; the controller's source remembers whether they won (memory flag `clashWon`). */
  | { kind: 'clash' }
  | { kind: 'preventAll'; combat?: boolean; source?: ObjectFilter; to: 'all' | 'you' | 'creaturesYouControl' | 'youAndCreaturesYouControl' | 'players' | 'creatures' | ObjectFilter; /** Only the next time damage would be dealt ("the next time a source of your choice would deal damage to you this turn"). */ once?: boolean }
  /** "Reveal cards from the top of your library until you reveal a X card. Put that card ... and the rest ..." */
  | { kind: 'revealUntil'; filter: ObjectFilter; destination: 'hand' | 'battlefield' | 'graveyard' | 'exile'; rest: 'bottom' | 'graveyard' | 'exile'; tapped?: boolean; who?: Ref }
  | { kind: 'manual'; text: string }; // engine cannot automate this; prompt the player

// ---------------------------------------------------------------------------
// Abilities
// ---------------------------------------------------------------------------

/** Constrains which game events fire a trigger. */
export interface TriggerFilter {
  /** Event's primary object must be the script's own object. */
  self?: boolean;
  /** Event's primary object must match. */
  object?: ObjectFilter;
  /** Event's source (e.g. damage source) must match. */
  source?: ObjectFilter;
  /** Event player must be... */
  player?: 'you' | 'opponent' | 'any' | 'notYou';
  /** Other player (e.g. defending player) must be ... */
  otherPlayer?: 'you' | 'opponent' | 'any';
  /** Combat damage only / non-combat only */
  combat?: boolean;
  /** Active player restriction. */
  yourTurn?: boolean;
  notYourTurn?: boolean;
  /** For zone-change events */
  fromZone?: ZoneName;
  toZone?: ZoneName;
  /** For counter events */
  counterType?: CounterType;
  /** Only the first time each turn. */
  firstEachTurn?: boolean;
  /** Attack on you or a planeswalker you control (for "attacks you"). */
  attacksYou?: boolean;
  /** Object controller relative to the script's controller. */
  objectController?: 'you' | 'opponent' | 'any';
  /** Trigger only when the cast spell was the Nth this turn, etc. */
  nthThisTurn?: number;
  /** Trigger only when this is at least the Nth such event this turn ("other than your first spell each turn"). */
  minNthThisTurn?: number;
  /** Event amount threshold (e.g. "5 or more damage"). */
  minAmount?: number;
  /** Damage dealt to a player specifically (dealtDamage events). */
  toPlayer?: boolean;
  /** For zone-change events: the object must not have come from this zone. */
  notFromZone?: ZoneName;
  /** The event object must be what the source is attached to ("When enchanted creature dies"). */
  attachedToSource?: boolean;
  /** The event's source (damage dealer) must be what the source is attached to ("Whenever equipped creature deals damage"). */
  sourceAttachedTo?: boolean;
  /** For cast events: the spell must target the source (heroic). */
  targetsSource?: boolean;
  /** Delayed triggers only: watch these specific objects ("When that creature dies this turn"). */
  objectRef?: Ref;
  /** For cast events: the spell must target an object you control matching this ("Whenever you cast a spell that targets a creature you control"). */
  targetsControlled?: ObjectFilter;
  /** Custom */
  custom?: string;
}

export interface AbilityCost {
  mana?: string;
  tap?: boolean;
  untap?: boolean;
  sacrificeSelf?: boolean;
  sacrifice?: { filter: ObjectFilter; count?: number };
  payLife?: number | 'X';
  discard?: { count: number | 'X'; filter?: ObjectFilter; random?: boolean } | 'hand';
  /** amount 'X' = the chosen X ("Remove X counters", "Remove any number of counters"). */
  removeCounters?: { counter: CounterType; amount: number | 'X' | 'all' };
  addCounters?: { counter: CounterType; amount: number };
  exileFromGraveyard?: { filter: ObjectFilter; count: number };
  exileSelf?: boolean;
  /** Discard this card (cycling, channel). */
  discardSelf?: boolean;
  /** Return this permanent to hand as a cost. */
  returnSelf?: boolean;
  /** Reveal this card from your hand (free; the ability works from the hand). */
  revealSelf?: boolean;
  tapUntapped?: { filter: ObjectFilter; count: number };
  /** Crew / saddle: tap any number of untapped matching creatures with total power N or more. */
  tapUntappedTotalPower?: { filter: ObjectFilter; power: number };
  returnToHand?: { filter: ObjectFilter; count: number };
  loyalty?: number;
  energy?: number;
  /** Cost text we cannot enforce; player confirms they paid. */
  manual?: string;
  /** "Sacrifice a creature or pay {3}": the player picks one option to pay. */
  choice?: AbilityCost[];
}

export interface TriggeredAbilitySpec {
  kind: 'triggered';
  text: string;
  event: GameEventName;
  filter?: TriggerFilter;
  /** Intervening "if" clause; checked on trigger and on resolution. */
  condition?: Condition;
  /** "you may ..." — controller is asked whether to apply. */
  optional?: boolean;
  targets?: TargetSpec[];
  effects: Effect[];
  /** Zone the object must be in for the ability to function (default battlefield). */
  zone?: ZoneName | ZoneName[];
  /** For "dies"/"leaves" triggers the object is already gone; look back. */
  leavesTheBattlefield?: boolean;
  oncePerTurn?: boolean;
}

export interface ActivatedAbilitySpec {
  kind: 'activated';
  text: string;
  cost: AbilityCost;
  targets?: TargetSpec[];
  effects: Effect[];
  /** Produces mana and doesn't target: doesn't use the stack. */
  manaAbility?: boolean;
  sorcerySpeed?: boolean;
  /** Zone the ability can be activated from (default battlefield). */
  zone?: ZoneName;
  oncePerTurn?: boolean;
  /** Exhaust: activate only once per game (per object). */
  exhaust?: boolean;
  condition?: Condition;
  /** Only the controller of the object may activate (default) or any player. */
  anyPlayer?: boolean;
}

export interface StaticAbilitySpec {
  kind: 'static';
  text: string;
  /** Characteristic-changing effect on matching objects. */
  affects?: ObjectFilter | 'self' | 'attachedTo' | 'attachedToController';
  modification?: Modification;
  /** Non-characteristic rule change (cost reduction, can't attack ...). */
  rule?: RuleModification;
  ruleAffects?: ObjectFilter | 'self' | 'controller' | 'opponents' | 'allPlayers' | 'attachedToController';
  condition?: Condition;
  zone?: ZoneName; // battlefield default; e.g. graveyard for some
}

export interface SpellAbilitySpec {
  kind: 'spell';
  targets?: TargetSpec[];
  effects: Effect[];
  /** Modal: "Choose one —" */
  modes?: { text: string; targets?: TargetSpec[]; effects: Effect[] }[];
  minModes?: number;
  maxModes?: number;
  /** "If you control a commander as you cast this spell, you may choose both instead." */
  maxModesIf?: { condition: Condition; max: number };
  /** "You may choose the same mode more than once." */
  modesRepeatable?: boolean;
}

/** Replacement effects modeled for the common cases. */
export type ReplacementSpec =
  | { kind: 'replacement'; text: string; event: 'entersBattlefield'; self: true; tapped?: boolean; /** "enters tapped unless ..." */ unless?: Condition; /** Only applies when true ("If ~ was kicked, it enters with ..."). */ condition?: Condition; /** Clones: "You may have ~ enter as a copy of any creature on the battlefield." */ enterAsCopy?: ObjectFilter; enterAsCopyOptional?: boolean; counters?: { counter: CounterType; amount: Amount }; choose?: 'color' | 'creatureType' | 'opponent' | 'cardName' | 'player' | 'number' | 'option'; chooseOptions?: string[]; chooseKey?: string; effects?: Effect[]; payLifeOrTapped?: number }
  | { kind: 'replacement'; text: string; event: 'entersBattlefield'; self?: false; filter: ObjectFilter; tapped?: boolean; counters?: { counter: CounterType; amount: Amount } }
  | { kind: 'replacement'; text: string; event: 'dies' | 'leavesBattlefield' | 'putIntoGraveyard'; self: true; instead: 'exile' | 'returnToHand' | 'shuffleIntoLibrary' | 'commandZone'; mayChoose?: boolean; effects?: Effect[] }
  /** "If a creature an opponent controls would die, exile it instead." / Rest in Peace */
  | { kind: 'replacement'; text: string; event: 'dies' | 'putIntoGraveyard'; self: false; filter: ObjectFilter; instead: 'exile' }
  | { kind: 'replacement'; text: string; event: 'draw'; extraDraws?: number; skipFirstDraw?: boolean }
  | { kind: 'replacement'; text: string; event: 'damage'; prevent: 'all' | number; to: 'self' | 'controller' | ObjectFilter; fromFilter?: ObjectFilter; combatOnly?: boolean; /** Run after preventing ("prevent that damage and put that many +1/+1 counters on it"); the amount prevented is the trigger amount. */ effects?: Effect[] }
  | { kind: 'replacement'; text: string; event: 'lifeGain'; multiply?: number; add?: number; who: 'you' | 'opponent' }
  | { kind: 'replacement'; text: string; event: 'counterAdded'; extra: number; multiply?: number; filter?: ObjectFilter; counterType?: CounterType }
  | { kind: 'replacement'; text: string; event: 'tokenCreated'; extra: number }
  | { kind: 'replacement'; text: string; event: 'wouldLoseGame'; instead: Effect[] }
  | { kind: 'replacement'; text: string; event: 'custom'; tag: string };

export type AbilitySpec = TriggeredAbilitySpec | ActivatedAbilitySpec | StaticAbilitySpec | SpellAbilitySpec | ReplacementSpec;

/** Keywords that carry a parameter. */
export interface KeywordSpec {
  keyword: string;
  /** e.g. Ward {2}, Kicker {1}{R}, Cycling {2}, Equip {3}, Bushido 1 */
  cost?: string;
  amount?: number;
}

export interface CostModifier {
  amount: number;
  direction: 'less' | 'more';
  /** Reduce/increase once per matching object. */
  per?: ObjectFilter;
  /** "costs {1} more to cast for each target beyond the first" */
  perExtraTarget?: boolean;
  /** Reduce/increase once per unit of an amount ("for each creature in your party"). */
  perAmount?: Amount;
  /** Applies when the spell targets a matching object ("costs {3} less to cast if it targets a tapped creature"). */
  ifTargets?: ObjectFilter;
  condition?: Condition;
  /** Colored reduction/increase: these exact symbols ("{U}{U}") are removed from / added to the cost `amount`×n times. */
  symbols?: string;
  text?: string;
}

export interface CardScript {
  /** Card name (front face). */
  name: string;
  abilities: AbilitySpec[];
  keywords?: KeywordSpec[];
  /** Additional costs "As an additional cost to cast this spell, ..." */
  additionalCost?: AbilityCost;
  /** "Cast ~ only during combat" / "only if you control a snow land": must hold to cast. */
  castCondition?: Condition;
  /** Alternative costs (e.g. warp, "You may pay {W} rather than pay this spell's mana cost if ..."). */
  alternativeCosts?: { id: string; text: string; cost: AbilityCost; condition?: Condition; zone?: ZoneName; /** Paying this cost lets the spell be cast as though it had flash. */ instantSpeed?: boolean }[];
  /** Cost changes the spell applies to itself ("costs {1} less to cast for each artifact you control", affinity). */
  costModifiers?: CostModifier[];
  /** How much of the card's text is automated. */
  coverage: 'full' | 'partial' | 'none';
  /** Where the script came from. */
  origin: 'hand' | 'compiled' | 'keywordsOnly';
  /** Lines of oracle text that could not be compiled (shown as manual reminders). */
  unhandledText?: string[];
  /** Scripts for the back / other faces. */
  faces?: CardScript[];
}

// ---------------------------------------------------------------------------
// Small helpers for writing scripts by hand.
// ---------------------------------------------------------------------------

export const E = {
  draw: (amount: Amount = 1, who?: Ref): Effect => ({ kind: 'draw', amount, who }),
  gainLife: (amount: Amount, who?: Ref): Effect => ({ kind: 'gainLife', amount, who }),
  loseLife: (amount: Amount, who?: Ref): Effect => ({ kind: 'loseLife', amount, who }),
  damage: (amount: Amount, to: Ref): Effect => ({ kind: 'damage', amount, to }),
  destroy: (what: Ref): Effect => ({ kind: 'destroy', what }),
  exile: (what: Ref): Effect => ({ kind: 'exile', what }),
  sacrifice: (what: Ref): Effect => ({ kind: 'sacrifice', what }),
  token: (token: TokenSpec, count: Amount = 1, opts: { tapped?: boolean; attacking?: boolean } = {}): Effect => ({ kind: 'createToken', token, count, ...opts }),
  counters: (counter: CounterType, amount: Amount, on: Ref): Effect => ({ kind: 'addCounters', counter, amount, on }),
  pump: (power: Amount, toughness: Amount, on: Ref, duration: Duration = 'endOfTurn'): Effect => ({ kind: 'pump', power, toughness, on, duration }),
  keywords: (keywords: string[], on: Ref, duration: Duration = 'endOfTurn'): Effect => ({ kind: 'grantKeywords', keywords, on, duration }),
  tap: (what: Ref): Effect => ({ kind: 'tap', what }),
  untap: (what: Ref): Effect => ({ kind: 'untap', what }),
  scry: (amount: Amount, who?: Ref): Effect => ({ kind: 'scry', amount, who }),
  mill: (amount: Amount, who?: Ref): Effect => ({ kind: 'mill', amount, who }),
  discard: (amount: Amount | 'hand', who?: Ref): Effect => ({ kind: 'discard', amount, who }),
  mana: (mana: ManaColor[] | 'anyColor', amount?: Amount): Effect => ({ kind: 'addMana', mana, amount }),
  counter: (what: Ref = R.target()): Effect => ({ kind: 'counterSpell', what }),
  bounce: (what: Ref): Effect => ({ kind: 'returnToHand', what }),
  may: (effects: Effect[], prompt?: string): Effect => ({ kind: 'may', effects, prompt }),
  when: (cond: Condition, then: Effect[], otherwise?: Effect[]): Effect => ({ kind: 'conditional', if: cond, then, else: otherwise }),
  manual: (text: string): Effect => ({ kind: 'manual', text }),
};

export const T = {
  creature: (desc = 'target creature', filter: ObjectFilter = {}): TargetSpec => ({ description: desc, kind: 'object', filter: { zone: 'battlefield', types: ['Creature'], ...filter } }),
  permanent: (desc = 'target permanent', filter: ObjectFilter = {}): TargetSpec => ({ description: desc, kind: 'object', filter: { zone: 'battlefield', ...filter } }),
  player: (desc = 'target player', playerFilter: TargetSpec['playerFilter'] = 'any'): TargetSpec => ({ description: desc, kind: 'player', playerFilter }),
  opponent: (desc = 'target opponent'): TargetSpec => ({ description: desc, kind: 'player', playerFilter: 'opponent' }),
  any: (desc = 'any target'): TargetSpec => ({ description: desc, kind: 'any' }),
  spell: (desc = 'target spell', filter: ObjectFilter = {}): TargetSpec => ({ description: desc, kind: 'spell', filter }),
  object: (desc: string, filter: ObjectFilter): TargetSpec => ({ description: desc, kind: 'object', filter }),
};
