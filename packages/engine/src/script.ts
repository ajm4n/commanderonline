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
  | { kind: 'countersOn'; ref: Ref; counter: CounterType | 'any' }
  | { kind: 'power'; ref: Ref }
  | { kind: 'toughness'; ref: Ref }
  | { kind: 'manaValue'; ref: Ref }
  | { kind: 'life'; ref: Ref }
  | { kind: 'handSize'; ref: Ref }
  | { kind: 'graveyardSize'; ref: Ref; filter?: ObjectFilter }
  | { kind: 'triggerAmount' } // damage dealt / life gained / etc. captured by trigger
  | { kind: 'devotion'; colors: Color[]; /** Devotion to the color chosen under this key on the source. */ chosenKey?: string }
  | { kind: 'landsYouControl' }
  | { kind: 'opponents' }
  | { kind: 'commanderTax' }
  /** Times you have cast a commander from the command zone this game. */
  | { kind: 'commanderCasts' }
  /** The controller's starting life total. */
  | { kind: 'startingLife'; ref?: Ref }
  /** The most recent die roll or chosen number in this resolution. */
  | { kind: 'lastRoll' }
  | { kind: 'cardsDrawnThisTurn' }
  | { kind: 'spellsCastThisTurn' }
  | { kind: 'turnStat'; key: string }
  /** Number of mana symbols of a colour in an object's mana cost ("for each white mana symbol in its mana cost"). */
  | { kind: 'manaSymbolCount'; ref: Ref; color?: string }
  /** Number of distinct creature types an object has ("for each of its creature types"). */
  | { kind: 'creatureTypeCount'; ref: Ref }
  | { kind: 'memory'; key: string }
  | { kind: 'sum'; parts: Amount[] }
  | { kind: 'times'; a: Amount; b: Amount }
  | { kind: 'max'; a: Amount; b: Amount }
  /** a - b, never below zero ("draw cards equal to the difference"). */
  | { kind: 'minus'; a: Amount; b: Amount }
  | { kind: 'chosenNumber' }
  | { kind: 'differenceLife'; from: Ref; to: Ref }
  | { kind: 'ctxMemory'; key: string }
  | { kind: 'half'; a: Amount; round?: 'up' | 'down' }
  /** "For every seven cards in your graveyard": integer division. */
  | { kind: 'divide'; a: Amount; by: number; round?: 'up' | 'down' }
  /** "Each unspent green mana you have." */
  | { kind: 'manaPool'; color: 'W' | 'U' | 'B' | 'R' | 'G' | 'C'; who?: Ref }
  | { kind: 'librarySize'; ref: Ref }
  /** Number of objects a Ref resolves to (optionally filtered), e.g. "creature cards milled this way". */
  | { kind: 'countRef'; ref: Ref; filter?: ObjectFilter }
  /** Cards the given player discarded by the current effect. */
  | { kind: 'discardedThisWay'; ref: Ref }
  /** Sum of power of matching objects ("creatures you control have total power 8 or greater"). */
  | { kind: 'totalPower'; filter: ObjectFilter }
  | { kind: 'totalToughness'; filter: ObjectFilter }
  /** "the greatest power among creatures you control" */
  | { kind: 'maxOf'; stat: 'power' | 'toughness' | 'manaValue'; filter: ObjectFilter }
  /** Number of party roles (Cleric, Rogue, Warrior, Wizard) among creatures you control. */
  | { kind: 'partySize' }
  /** Times the spell was kicked (multikicker). */
  | { kind: 'kickCount' }
  /** Number of events of a kind this turn ("creatures that died this turn", "spells your opponents cast this turn"). */
  | { kind: 'eventsThisTurn'; event: GameEventName; player?: 'you' | 'opponent' | 'any'; /** Only count events whose object matched this ("each Zubera that died this turn"). */ filter?: ObjectFilter }
  /** Number of distinct kinds of counter on an object. */
  | { kind: 'distinctCounterKinds'; ref: Ref }
  /** Sum of mana values of matching objects. */
  | { kind: 'totalManaValue'; filter: ObjectFilter }
  /** Number of colors of the referenced object(s). */
  /** Mana spent to cast the source: distinct colors, total, or how many times a symbol group was paid. */
  | { kind: 'manaSpent'; of: 'colors' | 'total'; symbols?: string }
  /** How many votes an option received (see the `vote` effect). */
  | { kind: 'voteCount'; option: string }
  | { kind: 'colorCount'; ref?: Ref; /** Distinct colors among objects matching this filter ('colors among permanents you control'). */ filter?: ObjectFilter }
  /** A per-player turn statistic ("life you gained this turn"). */
  | { kind: 'playerTurnStat'; key: string; ref?: Ref; /** Sum the stat across every opponent instead of one player. */ opponents?: boolean }
  /** A player counter total, summed over the players a ref resolves to. */
  | { kind: 'playerStatAmount'; stat: 'poison' | 'experience' | 'energy'; ref: Ref }
  /** Total power of the objects a ref resolves to. */
  | { kind: 'totalPowerRef'; ref: Ref }
  | { kind: 'lowestLife' }
  | { kind: 'highestLife' }
  | { kind: 'totalToughnessRef'; ref: Ref }
  | { kind: 'totalManaValueRef'; ref: Ref }
  /** Number of players with a non-zero turn stat ("each opponent who lost life this turn"). */
  | { kind: 'playersMatching'; who: 'opponent' | 'any'; stat: string }
  /** Number of graveyards with at least this many cards. */
  | { kind: 'graveyardsWithAtLeast'; count: number }
  /** Number of distinct values of a stat among matching objects ("creatures with different powers"). */
  | { kind: 'distinctValues'; stat: 'power' | 'toughness' | 'manaValue' | 'name'; filter: ObjectFilter }
  /** Domain: basic land types among lands you control. */
  | { kind: 'domain' }
  /** Number of card types among matching objects. */
  | { kind: 'cardTypesAmong'; filter: ObjectFilter };

export type Ref =
  | { ref: 'target'; slot?: number }
  | { ref: 'self' }
  /** The current monarch, if any. */
  | { ref: 'monarch' }
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
  | { ref: 'lastDiscarded' }
  | { ref: 'lastRevealed' }
  /** Objects remembered under a memory key by an earlier effect in the same resolution. */
  | { ref: 'memory'; key: string }
  | { ref: 'defendingPlayer' }
  | { ref: 'activePlayer' }
  | { ref: 'chosen'; key: string }
  | { ref: 'stackTarget' } // the spell targeted (for counterspells)
  /** The spell or ability whose activation triggered this ability. */
  | { ref: 'triggerStackItem' }
  | { ref: 'controllerOf'; of: Ref }
  | { ref: 'ownerOf'; of: Ref }
  | { ref: 'blockersOf'; of: Ref }
  | { ref: 'ringBearer' }
  | { ref: 'player'; id: PlayerId }
  /** Opponents of the controller other than the trigger's player ("each other opponent"). */
  | { ref: 'eachOtherOpponent' }
  /** The player or planeswalker the referenced creature is attacking. */
  | { ref: 'defenderOf'; of: Ref }
  /** The union of several refs ("you and target opponent each ..."). */
  | { ref: 'players'; of: Ref[] }
  /** Every player except those this ref resolves to ("each player other than target player"). */
  | { ref: 'playersExcept'; except: Ref }
  /** The player seated next to you: left is the next in turn order, right the previous. */
  | { ref: 'neighbor'; side: 'left' | 'right' }
  /** The player with the most (or least) of something; ties resolve to nobody. */
  | { ref: 'playerWithMost'; what: 'life' | 'cards' | { filter: ObjectFilter }; least?: boolean };

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
  /** Planeswalker tokens. */
  loyalty?: string;
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
  exceptions?: { /** Quoted rules text the copy also has. */ abilities?: string[]; keywords?: string[]; haste?: boolean; addSubtypes?: string[]; addTypes?: string[]; notLegendary?: boolean; legendary?: boolean; power?: string; toughness?: string; colors?: Color[]; name?: string; /** "except it has this ability": the copying object's own copy ability is kept. */ thisAbility?: boolean };
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
  /** The value chosen under `key` on the source equals `value` ("choose Abzan or Mardu"). */
  | { kind: 'chosenIs'; key: string; value: string }
  | { kind: 'turnStat'; key: string; op: Comparison; value: number }
  | { kind: 'controlsCommander' }
  | { kind: 'commanderOnBattlefield' }
  | { kind: 'inZone'; ref: Ref; zone: ZoneName }
  | { kind: 'playerStat'; stat: 'ringLevel' | 'dungeonsCompleted' | 'poison' | 'experience' | 'energy'; ref?: Ref; op: Comparison; value: Amount }
  | { kind: 'hasInitiative'; ref?: Ref }
  | { kind: 'eventThisTurn'; event: GameEventName; player?: 'you' | 'opponent' | 'any'; who?: Ref; op?: Comparison; value?: number; /** Only count events whose object matched this. */ filter?: ObjectFilter }
  | { kind: 'not'; c: Condition }
  /** The current step/phase ("Activate only during your upkeep"). */
  | { kind: 'turnStep'; steps: string[]; player?: 'you' | 'opponent' | 'any'; beforeAttackers?: boolean }
  | { kind: 'and'; cs: Condition[] }
  | { kind: 'or'; cs: Condition[] }
  /** Ascend: the controller has the city's blessing (ten or more permanents at some point while controlling an Ascend source). */
  | { kind: 'cityBlessing'; ref?: Ref }
  /** Day/night cycle state. */
  | { kind: 'dayNight'; is: 'day' | 'night' | 'neither' }
  /** Rooms: this door (face index) is unlocked. */
  | { kind: 'doorUnlocked'; door: number; not?: boolean }
  /** The permanent is face down (morph, manifest). */
  | { kind: 'faceDown'; ref?: Ref }
  /** Soulbond: the object is paired with another creature. */
  | { kind: 'paired'; ref?: Ref }
  /** The named vote option got strictly more votes than every other option. */
  | { kind: 'voteMost'; option: string }
  /** A flag the current effect set earlier ("if you search your library this way", "if you win the flip"). */
  | { kind: 'ctxFlag'; key: string }
  /** Count of events during the previous turn ("if a player cast two or more spells last turn"). */
  | { kind: 'eventLastTurn'; event: GameEventName; player?: 'you' | 'opponent' | 'any'; op?: Comparison; value?: number }
  /** Some opponent compares to you ("an opponent controls more lands than you", "an opponent has more life than you"). */
  | { kind: 'opponentCompare'; what: 'life' | ObjectFilter; op: Comparison }
  /** The players `who` resolves to control the most (ties included) objects matching the filter. */
  | { kind: 'controlsMost'; filter: ObjectFilter; who?: Ref }
  /** "This is the second time this ability has resolved this turn" (counts the current resolution). */
  | { kind: 'abilityResolvedThisTurn'; op: Comparison; value: number }
  /** The largest group of same-named matching permanents ("three or more lands with the same name"). */
  | { kind: 'sameNameGroup'; filter: ObjectFilter; op: Comparison; value: number }
  | { kind: 'manual'; text: string }; // engine asks the controller yes/no

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export interface TargetSpec {
  description: string;
  /** any = creature, player, planeswalker or battle */
  kind: 'object' | 'player' | 'any' | 'spell' | 'objectOrPlayer' | 'activatedOrTriggered' | 'spellOrAbility' | 'objectOrSpell';
  filter?: ObjectFilter;
  playerFilter?: 'any' | 'opponent' | 'you' | 'notController';
  min?: number; // default 1
  max?: number; // default 1
  /** Different targets from other slots. */
  distinct?: boolean;
  /** All chosen targets must share a controller ("two target creatures controlled by the same player"). */
  sameController?: boolean;
  /** The chosen targets' total mana value must not exceed this. */
  totalManaValueLE?: number;
  /** Only choose targets when a condition applies; otherwise skip. */
  optional?: boolean;
  /** Target count is X, or a multiple of it ("X target cards", "up to twice X target cards"). */
  countX?: { times?: number; upTo?: boolean };
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
  | { kind: 'damage'; amount: Amount; to: Ref; source?: Ref; divided?: boolean; /** "Excess damage is dealt to that creature's controller instead." */ excessToController?: boolean }
  | { kind: 'destroy'; what: Ref; cantRegenerate?: boolean }
  | { kind: 'exile'; what: Ref; untilSourceLeaves?: boolean; remember?: string; counters?: { counter: CounterType; amount: Amount }; /** "exile all cards from your hand face down" */ faceDown?: boolean }
  | { kind: 'sacrifice'; what: Ref }
  | { kind: 'sacrificeChoice'; who: Ref; filter: ObjectFilter; count: Amount; /** "sacrifice any number of lands": the player may sacrifice fewer. */ upTo?: boolean; unlessAlso?: never }
  | { kind: 'returnToHand'; what: Ref }
  | { kind: 'returnToBattlefield'; what: Ref; tapped?: boolean; controller?: 'you' | 'owner'; counters?: { counter: CounterType; amount: Amount }; transformed?: boolean; /** "tapped and attacking" */ attacking?: boolean; /** Return attached to this object (Auras/Equipment). */ attachTo?: Ref }
  | { kind: 'putOnLibrary'; what: Ref; position: 'top' | 'bottom' | 'secondFromTop' | 'ownerChoice'; /** 0-based depth from the top ("third from the top" = 2). */ depth?: number }
  /** Exert: the object won't untap during its controller's next untap step. */
  | { kind: 'exert'; what: Ref }
  /** "Target land becomes the basic land type of your choice" / "~ becomes the creature type of your choice". */
  | { kind: 'setSubtypes'; on: Ref; subtypes?: string[]; choose?: 'basicLandType' | 'creatureType'; duration?: Duration }
  /** "When ~ leaves the battlefield, put its counters on target creature you control." */
  | { kind: 'moveCounters'; from: Ref; to: Ref; counter?: CounterType; amount?: Amount }
  /** "~ becomes a copy of that creature" (permanently). */
  | { kind: 'becomeCopy'; what: Ref; of: Ref; exceptions?: TokenSpec['exceptions'] }
  | { kind: 'moveToZone'; what: Ref; zone: ZoneName; position?: 'top' | 'bottom' }
  | { kind: 'createToken'; token: TokenSpec; count: Amount; tapped?: boolean; attacking?: boolean; who?: Ref; /** Role tokens: attach the created Aura to this object. */ attachTo?: Ref; /** Counters the token enters with. */ counters?: { counter: CounterType; amount: Amount } }
  | { kind: 'addCounters'; counter: CounterType; amount: Amount; on: Ref; /** "Distribute N counters among ..." */ divided?: boolean ; /** "your choice of a +1/+1, first strike, or trample counter" */ counterOptions?: string[]; /** "Put up to X counters on ~": the controller picks how many. */ upTo?: boolean }
  | { kind: 'removeCounters'; counter: CounterType; amount: Amount | 'all'; on: Ref; /** "Remove up to three counters": the controller may remove fewer. */ upTo?: boolean }
  | { kind: 'pump'; power: Amount; toughness: Amount; on: Ref; duration?: Duration }
  | { kind: 'setPT'; power?: Amount; toughness?: Amount; on: Ref; duration?: Duration }
  /** "Target unblocked attacking creature becomes blocked." */
  | { kind: 'becomeBlocked'; what: Ref }
  /** "Exchange your life total with ~'s power." */
  | { kind: 'exchangeLifeWith'; what: Ref; stat: 'power' | 'toughness'; who?: Ref }
  /** "Exchange your hand and graveyard." */
  | { kind: 'exchangeZones'; a: ZoneName; b: ZoneName; who?: Ref; shuffle?: boolean }
  | { kind: 'grantKeywords'; keywords: string[]; on: Ref; duration?: Duration; /** Grant only this many of `keywords`, chosen by the controller ("gains your choice of flying or haste"). */ choose?: number }
  /** "~ loses defender until end of turn." */
  | { kind: 'loseKeywords'; keywords: string[]; on: Ref; duration?: Duration }
  | { kind: 'removeKeywords'; keywords: string[]; on: Ref; duration?: Duration }
  | { kind: 'loseAllAbilities'; on: Ref; duration?: Duration }
  | { kind: 'addTypes'; types: string[]; on: Ref; duration?: Duration; subtypes?: string[]; /** Replace the object's card types instead of adding to them ("It's an enchantment"). */ setTypes?: string[]; /** Replace subtypes outright ("loses all creature types"). */ setSubtypes?: string[]; addSupertypes?: import('./types.js').Supertype[]; removeSupertypes?: import('./types.js').Supertype[] }
  | { kind: 'setColors'; colors: Color[]; on: Ref; duration?: Duration; /** "the color or colors of your choice" */ chooseColors?: boolean; /** Use the colour stored under this memory key instead of `colors`. */ chosenKey?: string }
  | { kind: 'applyRule'; rule: RuleModification; on: Ref; duration?: Duration }
  | { kind: 'tap'; what: Ref }
  | { kind: 'untap'; what: Ref }
  | { kind: 'scry'; amount: Amount; who?: Ref }
  | { kind: 'surveil'; amount: Amount; who?: Ref }
  | { kind: 'mill'; amount: Amount; who?: Ref }
  | { kind: 'discard'; amount: Amount | 'hand'; who?: Ref; random?: boolean; /** The player may discard fewer ("discards any number of cards"). */ upTo?: boolean; chooser?: 'self' | 'controller'; /** With amount 'hand': only cards matching ("discards all nonland cards"). */ filter?: ObjectFilter; /** With amount 'hand': keep these cards ("chooses a card in their hand and discards the rest"). */ except?: Ref }
  | { kind: 'addMana'; mana: ManaColor[] | 'anyColor' | 'anyOneColor' | 'commanderColors' | 'chosenColor' | 'triggerMana'; amount?: Amount; who?: Ref }
  | { kind: 'counterSpell'; what: Ref; unlessPays?: string; exileInstead?: boolean }
  | { kind: 'searchLibrary'; who?: Ref; filter: ObjectFilter; count: Amount; /** `hold`: leave the found cards where they are and remember them under `key` for follow-up sentences. */ destination: 'hand' | 'battlefield' | 'top' | 'graveyard' | 'exile' | 'hold'; key?: string; tapped?: boolean; reveal?: boolean; shuffle?: boolean; /** "search your graveyard, hand, and/or library" */ zones?: ('library' | 'graveyard' | 'hand')[]; /** Pick at random instead of choosing ("return a card at random from your graveyard"). */ random?: boolean }
  | { kind: 'shuffle'; who?: Ref }
  | { kind: 'gainControl'; what: Ref; duration?: Duration; who?: Ref }
  | { kind: 'exchangeControl'; a: Ref; b: Ref }
  | { kind: 'copySpell'; what: Ref; count?: Amount }
  /** Copy a card (not a spell): a token copy is created in exile that its controller may then cast ("Copy target instant card in your graveyard. You may cast the copy"). */
  | { kind: 'copyCard'; what: Ref }
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
  | { kind: 'populate'; tapped?: boolean; attacking?: boolean }
  | { kind: 'becomeMonarch'; who?: Ref }
  | { kind: 'goad'; what: Ref }
  | { kind: 'regenerate'; what: Ref }
  | { kind: 'preventDamage'; amount: Amount | 'all'; to: Ref; duration?: Duration }
  | { kind: 'lookAtTop'; amount: Amount; who?: Ref; /** Who actually sees the cards; defaults to the library's owner. "Look at the top card of target player's library" is the controller looking. */ looker?: Ref; then: 'handRestBottom' | 'handRestGraveyard' | 'battlefieldRestBottom' | 'reorder' | 'topRestGraveyard' | 'graveyardRestTop' | 'handRestTop' | 'hold'; filter?: ObjectFilter; pick?: Amount; /** `hold`: leave the cards in the library and remember them under this memory key (default "looked") for follow-up effects. */ key?: string; /** Reveal the looked-at cards to all players. */ reveal?: boolean }
  /** Move the remembered cards (see lookAtTop `hold`) that are still in their library to a destination ("put the rest on the bottom of your library"). */
  | { kind: 'moveRest'; key: string; to: 'bottom' | 'bottomRandom' | 'graveyard' | 'exile' | 'top' | 'hand' }
  | { kind: 'revealTop'; who?: Ref; ifMatches?: ObjectFilter; then?: Effect[]; else?: Effect[]; destination?: 'hand' | 'graveyard' | 'bottom' | 'stay' }
  | { kind: 'castWithoutPaying'; what: Ref; exileAfter?: boolean }
  | { kind: 'castFrom'; what: Ref; anyManaType?: boolean; free?: boolean; exileAfter?: boolean }
  | { kind: 'playFromExile'; what: Ref; duration?: 'thisTurn' | 'permanent'; /** Airbend: castable for this cost instead of its mana cost. */ forCost?: string; /** The owner may cast it, not this effect's controller. */ owner?: boolean; /** Granted flashback: castable from the graveyard. */ fromGraveyard?: boolean; /** Exile it as it resolves. */ exileAfter?: boolean; /** "mana of any type can be spent to cast that spell" */ anyMana?: boolean }
  | { kind: 'chooseColor'; key: string; /** Only colors of cards in your graveyard. */ fromGraveyard?: boolean; /** Who chooses (default: the controller). */ who?: Ref }
  /** "you may pay any amount of {E}": remembers the amount under `key`. */
  | { kind: 'payEnergy'; max: number; key: string }
  /** "For each color among permanents you control, add one mana of that color." */
  | { kind: 'addManaPerColor'; filter: ObjectFilter }
  | { kind: 'chooseCreatureType'; key: string; /** Which set of types to pick from (default creature subtypes). */ pool?: 'creature' | 'land' | 'cardType' }
  | { kind: 'nameCard'; key: string }
  | { kind: 'setMemory'; key: string; value: unknown; /** Set it on this object instead of the source. */ on?: Ref }
  | { kind: 'incrementMemory'; key: string; by?: number }
  | { kind: 'conditional'; if: Condition; then: Effect[]; else?: Effect[] }
  | { kind: 'forEach'; over: Ref; effects: Effect[]; /** Only iterate objects matching this filter ("for each creature card exiled this way"). */ filter?: ObjectFilter }
  | { kind: 'repeat'; times: Amount; effects: Effect[] }
  /** "Repeat this process": run the effects again while the condition holds (bounded). */
  | { kind: 'repeatWhile'; condition?: Condition; effects: Effect[]; max?: number; /** "You may repeat this process any number of times": ask before each extra iteration. */ optional?: boolean }
  | { kind: 'may'; effects: Effect[]; prompt?: string; who?: Ref; /** "If you don't, ..." */ else?: Effect[] }
  | { kind: 'unlessPays'; who: Ref; cost: string | { mana: string; payLife: number } | { discard: number; random?: boolean; filter?: ObjectFilter } | { sacrifice: ObjectFilter; count?: number } | { payLife: number } | { returnToHand: ObjectFilter; count: number } | { exileFromGraveyard: ObjectFilter; count: number } | { tap: ObjectFilter; count?: number }; effects: Effect[]; /** Run these instead when the player does pay. */ thenEffects?: Effect[]; text?: string }
  | { kind: 'ifPays'; who?: Ref; cost: string; effects: Effect[]; /** Run these if the cost is not paid. */ else?: Effect[]; text?: string; payLife?: number; energy?: number; /** A non-mana cost the player may pay instead ("you may tap three untapped creatures you control"). */ payCostSpec?: AbilityCost }
  | { kind: 'changeTargets'; what: Ref }
  /** "End the turn." */
  | { kind: 'endTurn' }
  /** "End the combat phase": skip the rest of combat. */
  | { kind: 'endCombatPhase' }
  /** Forage: exile three cards from your graveyard, or sacrifice a Food. */
  | { kind: 'forage' }
  /** "Flip a coin until you lose a flip." — remembers the number of wins as `flipWins`. */
  | { kind: 'flipUntilLose' }
  /** "Choose odd or even." */
  | { kind: 'chooseOption'; key: string; options: string[] }
  /** "Each player shuffles the cards from their hand into their library, then draws that many cards." */
  | { kind: 'shuffleHandIntoLibraryAndDraw'; who: Ref; /** Put the cards on the bottom of the library in any order instead of shuffling. */ bottom?: boolean }
  /** "Shuffle a card from your hand into your library." */
  | { kind: 'handToLibrary'; count: Amount; who?: Ref; position?: 'top' | 'bottom'; shuffle?: boolean }
  /** "Shuffle your graveyard into your library." */
  | { kind: 'shuffleZoneIntoLibrary'; zone: ZoneName; who?: Ref }
  /** "Put the bottom card of your library into your graveyard." */
  | { kind: 'millBottom'; amount: Amount; who?: Ref }
  /** Collect evidence N: exile cards with total mana value N or more from your graveyard. */
  | { kind: 'collectEvidence'; n: Amount }
  /** Time travel: you may remove a time counter from each suspended card you own and each permanent you control with one. */
  | { kind: 'timeTravel' }
  /** Licids: end the "becomes an Aura" effect — unattach and drop the type change. */
  | { kind: 'unattach'; what: Ref }
  /** Split a remembered set of cards into two piles (stored as memory keys pile0 / pile1). */
  | { kind: 'separatePiles'; what: Ref; by: Ref; /** One pile is face down and the other face up. */ faceUpDown?: boolean }
  /** A player picks one of the two piles; it becomes memory key chosenPile, the other otherPile. */
  | { kind: 'choosePile'; by: Ref }
  /** "Double the number of each kind of counter on target permanent." */
  | { kind: 'doubleCounters'; on: Ref }
  /** "Remove it from combat." */
  | { kind: 'removeFromCombat'; what: Ref }
  /** "Suspect target creature." (it gets menace and can't block) */
  | { kind: 'suspect'; what: Ref }
  /** "Add two mana of different colors." */
  | { kind: 'addManaDifferentColors'; amount: Amount }
  /** ~ gains every activated ability of the matching objects. */
  | { kind: 'grantAllActivatedAbilities'; on: Ref; from: ObjectFilter; duration?: Duration }
  /** Grant a player rule for the rest of the turn. */
  | { kind: 'grantPlayerRule'; who?: Ref; rule: RuleModification }
  /** Grant a replacement effect for the rest of the turn ("until end of turn, if you would ..."). */
  | { kind: 'grantReplacement'; who?: Ref; spec: ReplacementSpec }
  /** "Double ~'s power until end of turn." */
  | { kind: 'doubleStat'; on: Ref; stat: 'power' | 'toughness' | 'both'; duration?: Duration }
  /** "Any player may sacrifice a creature of their choice." */
  | { kind: 'anyPlayerMaySacrifice'; filter: ObjectFilter; then?: Effect[] }
  /** "Any player may have ~ deal 6 damage to them": each player in turn order chooses; the effects run with that player as the controller. */
  | { kind: 'anyPlayerMay'; effects: Effect[]; prompt?: string }
  /** Endure N: put N +1/+1 counters on it, or create an N/N white Spirit creature token. */
  | { kind: 'endure'; on: Ref; amount: Amount }
  /** "puts it on their choice of the top or bottom of their library" */
  | { kind: 'topOrBottom'; what: Ref; /** "second from the top or on the bottom" */ second?: boolean }
  /** "Target opponent exiles a creature they control." */
  | { kind: 'exileChoice'; who: Ref; filter: ObjectFilter; count: Amount }
  /** "Target player reveals a card at random from their hand." */
  | { kind: 'revealRandomFromHand'; who: Ref; count: Amount }
  | { kind: 'exileTop'; amount: Amount; who?: Ref; faceDown?: boolean; /** Remember the exiled cards under this memory key. */ key?: string }
  | { kind: 'revealHand'; who: Ref; /** Look at only this many cards, chosen at random. */ count?: number; random?: boolean }
  | { kind: 'chooseObjects'; who?: Ref; filter: ObjectFilter; count: Amount; key: string; upTo?: boolean; owner?: Ref; /** Restrict candidates to the objects of a Ref (a previously chosen set). */ from?: Ref; /** Pick at random instead of choosing. */ random?: boolean }
  | { kind: 'discardObjects'; what: Ref }
  | { kind: 'ringTempts'; who?: Ref }
  | { kind: 'takeInitiative'; who?: Ref }
  | { kind: 'chooseMode'; options: { text: string; effects: Effect[] }[]; count?: number; /** "Choose up to X, where X is …" */ countAmount?: Amount; /** "Choose up to one": may choose fewer. */ min?: number; /** "Choose one that hasn't been chosen this turn": modes already used are unavailable. */ notChosen?: 'turn' | 'game'; /** "Choose one at random" */ random?: boolean }
  | { kind: 'delayedTrigger'; event: GameEventName; effects: Effect[]; text: string; once?: boolean; filter?: TriggerFilter; /** "Until end of turn, whenever X, Y": fires repeatedly this turn, then goes away. */ untilEndOfTurn?: boolean }
  | { kind: 'log'; text: string; /** Also emit this game event (for mechanics whose trigger is the action itself, e.g. exploring). */ event?: GameEventName; objectRef?: Ref }
  | { kind: 'ventureIntoDungeon' }
  | { kind: 'investigate'; count?: Amount; who?: Ref }
  | { kind: 'treasure'; count?: Amount; who?: Ref }
  | { kind: 'rollDie'; sides: number; results: { min: number; max: number; effects: Effect[] }[] }
  | { kind: 'phaseOut'; what: Ref }
  | { kind: 'putIntoHand'; what: Ref }
  | { kind: 'putIntoGraveyard'; what: Ref }
  | { kind: 'dealsDamageEqualToPower'; source: Ref; to: Ref }
  | { kind: 'exchangeLife'; a: Ref; b: Ref }
  | { kind: 'skipTurn'; who: Ref }
  /** "You skip your draw step this turn." */
  | { kind: 'skipStep'; step: string; who?: Ref }
  /** "You lose all poison counters." */
  | { kind: 'loseAllCounters'; counter: string; who?: Ref }
  /** Explore: reveal the top card; a land goes to hand, otherwise a +1/+1 counter and a choice. */
  | { kind: 'explore'; what: Ref }
  | { kind: 'monstrosity'; amount: Amount }
  | { kind: 'plot' }
  /** Move every card of a player's zone somewhere else ("exile target player's graveyard"). */
  | { kind: 'moveAll'; who: Ref; from: ZoneName; to: ZoneName }
  /** Choose a player and remember them under `key` (readable as { ref: 'chosen', key }). */
  | { kind: 'choosePlayer'; key: string; who: 'opponent' | 'any'; /** "choose an opponent at random" */ random?: boolean }
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
  /** "Starting with you, each player votes for death or taxes." Tallies land in memory `votes`. */
  | { kind: 'vote'; options: string[] }
  /** "Each player votes for a nonland permanent you don't control." The winners (ties included) land in memory `key`. */
  | { kind: 'voteObjects'; filter: ObjectFilter; key: string }
  /** Morph: turn a face-down permanent face up (megamorph adds counters). */
  | { kind: 'turnFaceUp'; what?: Ref; counters?: { counter: CounterType; amount: Amount } }
  /** "Turn ~ face down." (it becomes a 2/2 face-down creature) */
  | { kind: 'turnFaceDown'; what: Ref }
  /** Manifest the top card(s) of a library as face-down 2/2 creatures; `dread` looks at two and mills the other. */
  | { kind: 'manifest'; amount: Amount; who?: Ref; dread?: boolean; ward?: string; /** Manifest from the hand instead of the library. */ fromHand?: boolean }
  /** Rooms: unlock one of the card's doors (faces). */
  | { kind: 'unlockDoor'; door: number }
  /** Day/night: set the cycle, or start it when it is neither. */
  | { kind: 'setDayNight'; to: 'day' | 'night' | 'startDay' | 'startNight' }
  /** Empower <planeswalker> N: add N loyalty to a matching token you control, creating it first if needed. */
  | { kind: 'empower'; token: string; amount: Amount }
  | { kind: 'clash' }
  | { kind: 'preventAll'; combat?: boolean; source?: ObjectFilter; /** Shield: prevent at most this much damage, then wear off. */ amount?: number; /** Only damage from this specific object ("the next time that creature would deal damage"). */ sourceRef?: Ref; /** Run these when the prevention applies; `triggerAmount` is the prevented damage. */ effects?: Effect[]; /** Specific recipients (resolved when the effect resolves). */ toRef?: Ref; to: 'all' | 'you' | 'creaturesYouControl' | 'youAndCreaturesYouControl' | 'youAndPlaneswalkersYouControl' | 'players' | 'creatures' | ObjectFilter; /** Only the next time damage would be dealt ("the next time a source of your choice would deal damage to you this turn"). */ once?: boolean; /** "... is dealt to another target creature instead": the prevented damage is redirected here. */ redirectTo?: Ref; /** "... that spell deals that damage to its controller instead" */ redirectToSourceController?: boolean }
  /** "Reveal cards from the top of your library until you reveal a X card. Put that card ... and the rest ..." */
  | { kind: 'revealUntil'; filter: ObjectFilter; /** `hold` leaves the matches where they are and remembers them for follow-up sentences. */ destination: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'hold'; rest: 'bottom' | 'graveyard' | 'exile' | 'hand' | 'top'; tapped?: boolean; who?: Ref; /** Reveal until this many cards match ("until you reveal three nonland cards"). */ count?: Amount; key?: string }
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
  /** Nth such event this turn counting every player ("whenever the fourth spell of a turn is cast"). */
  nthThisTurnAllPlayers?: number;
  /** Trigger only when this is at least the Nth such event this turn ("other than your first spell each turn"). */
  minNthThisTurn?: number;
  /** Event amount threshold (e.g. "5 or more damage"). */
  minAmount?: number;
  /** Damage dealt to a player specifically (dealtDamage events). */
  toPlayer?: boolean;
  /** For zone-change events: the object must not have come from this zone. */
  notFromZone?: ZoneName;
  /** For zone-change events: the object must not be going to this zone ("leaves the battlefield without dying"). */
  notToZone?: ZoneName;
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
  /** For cast events: how many targets the spell must have. */
  minTargets?: number;
  maxTargets?: number;
  /** For cast events: the spell must target one or more objects matching this, whoever controls them. */
  targetsAny?: ObjectFilter;
  /** For abilityActivated events: the ability's text must start with this ("whenever you activate a ninjutsu ability"). */
  abilityTextPrefix?: string;
  /** Custom */
  custom?: string;
}

export interface AbilityCost {
  mana?: string;
  tap?: boolean;
  untap?: boolean;
  sacrificeSelf?: boolean;
  sacrifice?: { filter: ObjectFilter; count?: number | 'any' | 'X' };
  payLife?: number | 'X' | 'halfUp' | 'halfDown';
  discard?: { count: number | 'X'; filter?: ObjectFilter; random?: boolean } | 'hand';
  /** amount 'X' = the chosen X ("Remove X counters", "Remove any number of counters"). */
  removeCounters?: { counter: CounterType | 'any'; amount: number | 'X' | 'all' };
  addCounters?: { counter: CounterType; amount: number };
  exileFromGraveyard?: { filter: ObjectFilter; count: number | 'X' };
  exileSelf?: boolean;
  /** Discard this card (cycling, channel). */
  discardSelf?: boolean;
  /** Return this permanent to hand as a cost. */
  returnSelf?: boolean;
  /** Reveal this card from your hand (free; the ability works from the hand). */
  revealSelf?: boolean;
  /** Waterbend {N}: pay {N}, tapping untapped artifacts and creatures you control for {1} each. */
  waterbend?: number | 'X';
  /** Collect evidence N: exile cards with total mana value N or more from your graveyard (optional when "you may"). */
  collectEvidence?: { n: number; optional?: boolean };
  /** Behold a Dragon: reveal a matching creature card from your hand or choose one you control (free). */
  behold?: ObjectFilter;
  /** "behold a Kithkin and exile it" */
  beholdExile?: boolean;
  /** Reveal a matching card from your hand (free). */
  revealFromHand?: ObjectFilter;
  /** How many cards to reveal (default 1). */
  revealFromHandCount?: number;
  /** "As an additional cost, choose a creature type" (stored as memory `creatureType`). */
  chooseCreatureType?: boolean;
  /** Blight N: put N -1/-1 counters on a creature you control. */
  blight?: number;
  /** "you may blight 1": the blight cost is optional (memory `additionalCostPaid` records whether it was paid). */
  blightOptional?: boolean;
  tapUntapped?: { filter: ObjectFilter; count: number | 'any' | 'X' };
  /** "Untap two tapped blue creatures you control" */
  untapOther?: { filter: ObjectFilter; count: number };
  /** "Tap enchanted creature" / "Sacrifice enchanted creature" */
  tapAttached?: boolean;
  sacrificeAttached?: boolean;
  /** "Mill a card" / "Mill four cards" */
  mill?: number;
  /** "Exile the top card of your library" / "Exile the top creature card of your graveyard" */
  exileTop?: { count: number; from: 'library' | 'graveyard'; filter?: ObjectFilter };
  /** "Exert ~" */
  exert?: boolean;
  /** "Put a card from your hand on top of your library" */
  handToLibrary?: { count: number; position: 'top' | 'bottom' };
  /** "Remove a +1/+1 counter from a creature you control" */
  removeCountersFrom?: { counter: CounterType | 'any'; amount: number; filter: ObjectFilter };
  /** Crew / saddle: tap any number of untapped matching creatures with total power N or more. */
  tapUntappedTotalPower?: { filter: ObjectFilter; power: number };
  returnToHand?: { filter: ObjectFilter; count: number };
  loyalty?: number;
  energy?: number | 'X';
  /** Cost text we cannot enforce; player confirms they paid. */
  manual?: string;
  /** "Sacrifice a creature or pay {3}": the player picks one option to pay. */
  choice?: AbilityCost[];
  /** "you may sacrifice a creature": paying is optional (memory `additionalCostPaid` records the choice). */
  optional?: boolean;
  /** "Exile a creature you control" / "exile any number of creature cards from your graveyard". */
  exileObjects?: { filter: ObjectFilter; count: number | 'any' | 'X' };
  /** "Put a -1/-1 counter on a creature you control." */
  putCounters?: { counter: CounterType; amount: number; filter: ObjectFilter };
}

export interface TriggeredAbilitySpec {
  kind: 'triggered';
  text: string;
  event: GameEventName;
  filter?: TriggerFilter;
  /** Intervening "if" clause; checked on trigger and on resolution. */
  condition?: Condition;
  /** A state trigger ("When no creatures are on the battlefield, sacrifice ~"): fires when this becomes true. */
  stateCondition?: Condition;
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
  /** Only usable while the permanent is face down (the morph / disguise turn-up ability). */
  faceDownOnly?: boolean;
  /** "Activate no more than twice each turn." */
  perTurnLimit?: number;
  /** "Only your opponents may activate this ability." */
  opponentsOnly?: boolean;
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
  /** Spree: an extra mana cost per mode index, paid for each mode chosen. */
  modeCosts?: (string | undefined)[];
  /** "Choose one that hasn't been chosen this turn": modes already used are unavailable. */
  modesNotChosen?: 'turn' | 'game';
}

/** Replacement effects modeled for the common cases. */
export type ReplacementSpec =
  | { kind: 'replacement'; text: string; event: 'entersBattlefield'; self: true; /** Several kinds at once ("enters with a +1/+1 counter, a flying counter, and a shield counter on it"). */ countersList?: { counter: CounterType; amount: Amount }[]; /** "enters with your choice of a flying counter or a first strike counter on it" */ counterChoice?: { from: string[]; count: number }; tapped?: boolean; /** "enters tapped unless ..." */ unless?: Condition; /** Only applies when true ("If ~ was kicked, it enters with ..."). */ condition?: Condition; /** Clones: "You may have ~ enter as a copy of any creature on the battlefield." */ enterAsCopy?: ObjectFilter; enterAsCopyOptional?: boolean; /** "..., except it is an enchantment in addition to its other types" */ copyExceptions?: TokenSpec['exceptions']; /** Tribute N: an opponent may put N +1/+1 counters on it (memory `tributePaid`). */ tribute?: number; counters?: { counter: CounterType; amount: Amount }; choose?: 'color' | 'creatureType' | 'opponent' | 'cardName' | 'player' | 'number' | 'option'; chooseOptions?: string[]; chooseKey?: string; /** An opponent makes the choice ("as ~ enters, an opponent chooses a creature type"). */ chooseByOpponent?: boolean; /** The choice is made at random ("choose 2, 3, or 4 at random"). */ chooseAtRandom?: boolean; /** "As ~ enters, choose another creature you control." */ chooseObject?: ObjectFilter; effects?: Effect[]; payLifeOrTapped?: number }
  | { kind: 'replacement'; text: string; event: 'entersBattlefield'; self?: false; filter: ObjectFilter; tapped?: boolean; counters?: { counter: CounterType; amount: Amount } }
  | { kind: 'replacement'; text: string; event: 'dies' | 'leavesBattlefield' | 'putIntoGraveyard'; self: true; instead: 'exile' | 'returnToHand' | 'shuffleIntoLibrary' | 'commandZone' | 'libraryTop' | 'libraryBottom'; mayChoose?: boolean; effects?: Effect[] }
  /** "If a creature an opponent controls would die, exile it instead." / Rest in Peace */
  | { kind: 'replacement'; text: string; event: 'dies' | 'putIntoGraveyard'; self: false; filter: ObjectFilter; instead: 'exile' }
  | { kind: 'replacement'; text: string; event: 'draw'; extraDraws?: number; skipFirstDraw?: boolean }
  | { kind: 'replacement'; text: string; event: 'damage'; prevent: 'all' | number; to: 'self' | 'controller' | ObjectFilter; fromFilter?: ObjectFilter; combatOnly?: boolean; /** "If damage would be dealt to ~ while it has a +1/+1 counter on it" */ condition?: Condition; /** Run after preventing ("prevent that damage and put that many +1/+1 counters on it"); the amount prevented is the trigger amount. */ effects?: Effect[] }
  /** "If you would draw a card, draw two cards instead." / "…, you win the game instead." */
  | { kind: 'replacement'; text: string; event: 'drawCard'; who: 'you' | 'opponent' | 'any'; /** Draw this many instead of one. */ draws?: number; /** Replace the draw with these effects entirely. */ effects?: Effect[]; /** "that player skips that draw instead" */ skip?: boolean; condition?: Condition; /** Skip the first draw each of that player's draw steps. */ exceptFirstEachDrawStep?: boolean }
  | { kind: 'replacement'; text: string; event: 'lifeGain'; multiply?: number; add?: number; who: 'you' | 'opponent' | 'any'; /** "that player loses that much life instead" */ insteadLose?: boolean }
  /** "If an opponent would lose life during your turn, they lose twice that much life instead." */
  | { kind: 'replacement'; text: string; event: 'lifeLoss'; multiply?: number; add?: number; who: 'you' | 'opponent' | 'any'; yourTurnOnly?: boolean }
  /** "If an opponent would mill one or more cards, they mill twice that many cards instead." */
  | { kind: 'replacement'; text: string; event: 'mill'; multiply?: number; add?: number; who: 'you' | 'opponent' | 'any' }
  | { kind: 'replacement'; text: string; event: 'counterAdded'; extra: number; multiply?: number; /** "half that many … rounded down" */ half?: 'up' | 'down'; /** "that many minus one" */ minus?: number; filter?: ObjectFilter; counterType?: CounterType; /** Whose counter placement is replaced (default: the holder's own). */ who?: 'you' | 'opponent' | 'any' }
  | { kind: 'replacement'; text: string; event: 'tokenCreated'; extra: number; /** "those tokens plus a Clue token are created instead" */ alsoToken?: TokenSpec; /** "that many 4/4 white Angel creature tokens are created instead": the tokens created change. */ replaceToken?: TokenSpec; /** "half that many of each of those kinds of tokens instead, rounded down" */ half?: 'up' | 'down'; /** Whose token creation is replaced (default: the holder's own). */ who?: 'you' | 'opponent' | 'any'; /** Only replaces creature-token creation. */ creatureOnly?: boolean }
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
  alternativeCosts?: { id: string; text: string; cost: AbilityCost; condition?: Condition; zone?: ZoneName; /** Paying this cost lets the spell be cast as though it had flash. */ instantSpeed?: boolean; /** Morph / disguise: the spell resolves as a face-down 2/2 creature. */ faceDown?: boolean; /** Disguise: the face-down creature has ward {2}. */ ward?: string }[];
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
