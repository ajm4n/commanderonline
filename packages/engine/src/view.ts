/**
 * Per-player redacted view of the game, safe to send to a client.
 */
import type { Game } from './game.js';
import type { Decision, ObjectId, PlayerId, StackItem, TurnState, LogEntry, ManaPool, ZoneName, Color, RuleModification } from './types.js';
import { abilitiesOf, summoningSick, availableMana } from './casting.js';

export interface ObjectView {
  id: ObjectId;
  name: string;
  typeLine: string;
  oracleText: string;
  manaCost: string;
  manaValue: number;
  power: number | null;
  toughness: number | null;
  loyalty: number | null;
  colors: Color[];
  keywords: string[];
  types: string[];
  subtypes: string[];
  supertypes: string[];
  tapped: boolean;
  counters: Record<string, number>;
  damage: number;
  controller: PlayerId;
  owner: PlayerId;
  zone: ZoneName;
  attachedTo: ObjectId | null;
  attachments: ObjectId[];
  isCommander: boolean;
  commanderCasts: number;
  imageUri?: string;
  backImageUri?: string;
  scryfallId?: string;
  faceIndex: number;
  faceDown: boolean;
  hidden: boolean;
  summoningSick: boolean;
  attacking: PlayerId | ObjectId | null;
  blocking: ObjectId[];
  isToken: boolean;
  coverage: 'full' | 'partial' | 'none';
  unhandledText?: string[];
  abilities: { index: number; text: string; manaAbility: boolean }[];
  rules: RuleModification[];
  chosen: Record<string, unknown>;
  phasedOut: boolean;
  layout: string;
  hasBackFace: boolean;
  castFromZone?: ZoneName;
}

export interface PlayerView {
  id: PlayerId;
  name: string;
  life: number;
  poison: number;
  experience: number;
  energy: number;
  manaPool: ManaPool;
  commanderDamage: Record<ObjectId, number>;
  handCount: number;
  libraryCount: number;
  hand: ObjectId[] | null;
  graveyard: ObjectId[];
  exile: ObjectId[];
  command: ObjectId[];
  lost: boolean;
  lossReason?: string;
  isActive: boolean;
  hasPriority: boolean;
  isMonarch: boolean;
  landsPlayedThisTurn: number;
  /** Mana the viewer could produce right now (own seat only). */
  manaAvailable: number | null;
  ringLevel: number;
  dungeon: { name: string; room: string } | null;
  hasInitiative: boolean;
}

export interface GameView {
  you: PlayerId;
  players: PlayerView[];
  playerOrder: PlayerId[];
  objects: Record<ObjectId, ObjectView>;
  battlefield: ObjectId[];
  stack: (StackItem & { sourceName: string })[];
  turn: TurnState;
  decision: Decision | null;
  waitingOn: PlayerId | null;
  log: LogEntry[];
  over: boolean;
  winner: PlayerId | null;
  version: number;
  historyLength: number;
}

export function objectView(g: Game, id: ObjectId, viewer: PlayerId, reveal: boolean): ObjectView | null {
  const o = g.state.objects[id];
  if (!o) return null;
  const hiddenZone = o.zone === 'library' || (o.zone === 'hand' && o.owner !== viewer);
  const hidden = (hiddenZone && !reveal) || (o.faceDown && o.controller !== viewer && !reveal);
  if (hidden) {
    return {
      id,
      name: '',
      typeLine: '',
      oracleText: '',
      manaCost: '',
      manaValue: 0,
      power: null,
      toughness: null,
      loyalty: null,
      colors: [],
      keywords: [],
      types: [],
      subtypes: [],
      supertypes: [],
      tapped: o.tapped,
      counters: {},
      damage: 0,
      controller: o.controller,
      owner: o.owner,
      zone: o.zone,
      attachedTo: null,
      attachments: [],
      isCommander: false,
      commanderCasts: 0,
      faceIndex: 0,
      faceDown: o.faceDown,
      hidden: true,
      summoningSick: false,
      attacking: null,
      blocking: [],
      isToken: false,
      coverage: 'none',
      abilities: [],
      rules: [],
      chosen: {},
      phasedOut: false,
      layout: 'normal',
      hasBackFace: false,
    };
  }
  const ch = g.characteristics(id);
  const script = g.scriptFor(o);
  const face = o.faceIndex > 0 && o.card.faces?.[o.faceIndex] ? o.card.faces[o.faceIndex] : o.card;
  return {
    id,
    name: ch.name,
    typeLine: [...ch.supertypes, ...ch.types].join(' ') + (ch.subtypes.length ? ` — ${ch.subtypes.join(' ')}` : ''),
    oracleText: ch.oracleText,
    manaCost: ch.manaCost,
    manaValue: ch.manaValue,
    power: ch.power,
    toughness: ch.toughness,
    loyalty: ch.loyalty,
    colors: ch.colors,
    keywords: [...ch.keywords],
    types: ch.types,
    subtypes: ch.subtypes,
    supertypes: ch.supertypes,
    tapped: o.tapped,
    counters: o.counters,
    damage: o.damage,
    controller: o.controller,
    owner: o.owner,
    zone: o.zone,
    attachedTo: o.attachedTo,
    attachments: o.attachments,
    isCommander: o.isCommander,
    commanderCasts: o.commanderCasts,
    imageUri: face.imageUri ?? o.card.imageUri,
    backImageUri: o.card.faces?.[1]?.imageUri,
    scryfallId: o.card.scryfallId,
    faceIndex: o.faceIndex,
    faceDown: o.faceDown,
    hidden: false,
    summoningSick: o.zone === 'battlefield' && ch.types.includes('Creature') && summoningSick(g, o),
    attacking: o.attacking,
    blocking: o.blocking,
    isToken: !!o.card.isToken,
    coverage: script.coverage,
    unhandledText: script.unhandledText,
    abilities: o.zone === 'battlefield' || o.zone === 'graveyard' || o.zone === 'hand' || o.zone === 'command' ? abilitiesOf(g, o).map((a) => ({ index: a.index, text: a.spec.text, manaAbility: !!a.spec.manaAbility })) : [],
    rules: ch.rules,
    chosen: o.chosen,
    phasedOut: o.phasedOut,
    layout: o.card.layout,
    hasBackFace: !!(o.card.faces && o.card.faces.length > 1),
    castFromZone: o.castFromZone,
  };
}

export function viewFor(g: Game, viewer: PlayerId | null): GameView {
  const decision = viewer !== null && g.pending && g.pending.player === viewer ? g.pending : null;
  const revealIds = new Set<ObjectId>();
  if (decision) {
    if (decision.type === 'chooseObjects' && decision.revealToChooser) decision.candidates.forEach((id) => revealIds.add(id));
    if (decision.type === 'orderObjects') decision.objectIds.forEach((id) => revealIds.add(id));
    if (decision.type === 'mulligan') decision.hand.forEach((id) => revealIds.add(id));
  }
  const objects: Record<ObjectId, ObjectView> = {};
  for (const o of Object.values(g.state.objects)) {
    if (o.zone === 'library' && !revealIds.has(o.id)) continue; // library contents never sent
    const v = objectView(g, o.id, viewer ?? '__spectator__', revealIds.has(o.id));
    if (v) objects[o.id] = v;
  }
  const players: PlayerView[] = g.state.playerOrder.map((pid) => {
    const p = g.player(pid);
    return {
      id: pid,
      name: p.name,
      life: p.life,
      poison: p.poison,
      experience: p.experience,
      energy: p.energy,
      manaPool: p.manaPool,
      commanderDamage: p.commanderDamage,
      handCount: p.hand.length,
      libraryCount: p.library.length,
      hand: pid === viewer ? [...p.hand] : null,
      manaAvailable: pid === viewer ? availableMana(g, pid) : null,
      ringLevel: p.ringLevel,
      dungeon: p.dungeon,
      hasInitiative: g.state.initiative === pid,
      graveyard: [...p.graveyard],
      exile: [...p.exile],
      command: [...p.command],
      lost: p.lost,
      lossReason: p.lossReason,
      isActive: g.state.turn.activePlayer === pid,
      hasPriority: g.pending?.type === 'priority' && g.pending.player === pid,
      isMonarch: g.state.monarch === pid,
      landsPlayedThisTurn: p.landsPlayedThisTurn,
    };
  });
  return {
    you: viewer ?? '',
    players,
    playerOrder: g.state.playerOrder,
    objects,
    battlefield: [...g.state.battlefield],
    stack: g.state.stack.map((s) => ({ ...s, triggerContext: undefined, sourceName: g.state.objects[s.sourceId]?.card.name ?? s.text })),
    turn: g.state.turn,
    decision,
    waitingOn: g.pending?.player ?? null,
    log: g.state.log.filter((l) => !l.visibleTo || (viewer !== null && l.visibleTo.includes(viewer))).slice(-300),
    over: g.state.over,
    winner: g.state.winner,
    version: g.state.version,
    historyLength: g.history.length,
  };
}
