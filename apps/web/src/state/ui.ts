/** Transient board UI state: in-progress selections for the current decision, menus, dialogs. */
import { create } from 'zustand';
import type { Decision, ObjectId, ObjectView, PlayerId, Target } from '@commander/engine';
import { sameTarget } from '../lib/format.js';
import type { HoverRect } from '../components/Card.js';

export type MenuState = { kind: 'object'; id: ObjectId; x: number; y: number } | { kind: 'player'; id: PlayerId; x: number; y: number } | null;
export type BrowseState = { player: PlayerId; zone: 'graveyard' | 'exile' | 'command' | 'hand' } | null;
export type DialogState =
  | { kind: 'token' }
  | { kind: 'mana' }
  | { kind: 'number'; title: string; label: string; initial: number; onSubmit: (n: number) => void }
  | { kind: 'counter'; objectId: ObjectId }
  | { kind: 'face'; objectId: ObjectId }
  | { kind: 'altcost'; objectId: ObjectId }
  | { kind: 'give'; objectId: ObjectId }
  | { kind: 'confirmConcede' }
  | null;

interface UiState {
  decisionId: number | null;
  slot: number;
  targets: Target[][];
  attacks: Record<number, PlayerId | ObjectId>;
  defender: PlayerId | ObjectId | null;
  blocker: ObjectId | null;
  blocks: { blocker: ObjectId; attacker: ObjectId }[];
  objects: ObjectId[];
  hover: ObjectView | null;
  /** Where the hovered card sits on screen, so the large view can grow out of it. */
  hoverRect: HoverRect | null;
  menu: MenuState;
  browse: BrowseState;
  dialog: DialogState;
  selectedStackItem: number | null;

  syncDecision(d: Decision | null): void;
  setSlot(i: number): void;
  toggleTarget(t: Target, d: Decision): void;
  toggleAttacker(id: ObjectId, target: PlayerId | ObjectId): void;
  setDefender(t: PlayerId | ObjectId | null): void;
  setBlocker(id: ObjectId | null): void;
  addBlock(blocker: ObjectId, attacker: ObjectId): void;
  removeBlock(blocker: ObjectId): void;
  toggleObject(id: ObjectId, max: number): void;
  setHover(o: ObjectView | null, rect?: HoverRect): void;
  setMenu(m: MenuState): void;
  setBrowse(b: BrowseState): void;
  setDialog(d: DialogState): void;
  setSelectedStackItem(id: number | null): void;
}

const emptySelection = { slot: 0, targets: [] as Target[][], attacks: {} as Record<number, PlayerId | ObjectId>, defender: null, blocker: null, blocks: [], objects: [] as ObjectId[] };

export const useUi = create<UiState>((set, get) => ({
  decisionId: null,
  ...emptySelection,
  hover: null,
  hoverRect: null,
  menu: null,
  browse: null,
  dialog: null,
  selectedStackItem: null,

  syncDecision(d) {
    const id = d?.id ?? null;
    if (id === get().decisionId) return;
    const init = { ...emptySelection, decisionId: id };
    if (d?.type === 'chooseTargets') init.targets = d.slots.map(() => []);
    if (d?.type === 'declareAttackers') {
      // Pre-select creatures that must attack.
      const attacks: Record<number, PlayerId | ObjectId> = {};
      for (const c of d.candidates) if (c.mustAttack && c.canAttack.length) attacks[c.id] = c.canAttack[0];
      init.attacks = attacks;
    }
    set({ ...init, dialog: get().dialog?.kind === 'face' || get().dialog?.kind === 'altcost' ? null : get().dialog });
  },
  setSlot(i) {
    set({ slot: i });
  },
  toggleTarget(t, d) {
    if (d.type !== 'chooseTargets') return;
    const { slot, targets } = get();
    const cur = targets[slot] ?? [];
    const spec = d.slots[slot];
    if (!spec) return;
    const legal = spec.legal.some((l) => sameTarget(l, t));
    if (!legal) {
      // Maybe it is legal for another slot: jump there.
      const other = d.slots.findIndex((s, i) => i !== slot && s.legal.some((l) => sameTarget(l, t)) && (targets[i]?.length ?? 0) < s.max);
      if (other < 0) return;
      const next = targets.map((x) => [...x]);
      next[other] = [...(next[other] ?? []), t];
      set({ targets: next, slot: other });
      return;
    }
    const next = targets.map((x) => [...x]);
    if (cur.some((c) => sameTarget(c, t))) next[slot] = cur.filter((c) => !sameTarget(c, t));
    else if (cur.length >= spec.max) next[slot] = spec.max === 1 ? [t] : cur;
    else next[slot] = [...cur, t];
    let nextSlot = slot;
    if (next[slot].length >= spec.max) {
      const unfilled = d.slots.findIndex((s, i) => i > slot && (next[i]?.length ?? 0) < s.min);
      if (unfilled >= 0) nextSlot = unfilled;
    }
    set({ targets: next, slot: nextSlot });
  },
  toggleAttacker(id, target) {
    const attacks = { ...get().attacks };
    if (attacks[id] !== undefined && attacks[id] === target) delete attacks[id];
    else attacks[id] = target;
    set({ attacks });
  },
  setDefender(t) {
    set({ defender: t });
  },
  setBlocker(id) {
    set({ blocker: id });
  },
  addBlock(blocker, attacker) {
    const blocks = get().blocks.filter((b) => b.blocker !== blocker);
    blocks.push({ blocker, attacker });
    set({ blocks, blocker: null });
  },
  removeBlock(blocker) {
    set({ blocks: get().blocks.filter((b) => b.blocker !== blocker), blocker: null });
  },
  toggleObject(id, max) {
    const cur = get().objects;
    if (cur.includes(id)) set({ objects: cur.filter((x) => x !== id) });
    else if (cur.length >= max) set({ objects: max === 1 ? [id] : cur });
    else set({ objects: [...cur, id] });
  },
  setHover(o, rect) {
    set({ hover: o, hoverRect: o ? rect ?? null : null });
  },
  setMenu(m) {
    set({ menu: m });
  },
  setBrowse(b) {
    set({ browse: b });
  },
  setDialog(d) {
    set({ dialog: d });
  },
  setSelectedStackItem(id) {
    set({ selectedStackItem: id });
  },
}));

// ---------------------------------------------------------------------------
// Pure helpers used by the board to decorate cards.
// ---------------------------------------------------------------------------

export interface Highlights {
  playable: Set<ObjectId>;
  activatable: Set<ObjectId>;
  legalObjects: Set<ObjectId>;
  legalPlayers: Set<PlayerId>;
  legalStack: Set<number>;
  selectedObjects: Set<ObjectId>;
  selectedPlayers: Set<PlayerId>;
  selectedStack: Set<number>;
}

export function computeHighlights(d: Decision | null, ui: Pick<UiState, 'slot' | 'targets' | 'attacks' | 'blocker' | 'blocks' | 'objects' | 'defender'>): Highlights {
  const h: Highlights = { playable: new Set(), activatable: new Set(), legalObjects: new Set(), legalPlayers: new Set(), legalStack: new Set(), selectedObjects: new Set(), selectedPlayers: new Set(), selectedStack: new Set() };
  if (!d) return h;
  switch (d.type) {
    case 'priority':
      d.playableCards.forEach((id) => h.playable.add(id));
      d.activatableAbilities.forEach((a) => h.activatable.add(a.objectId));
      break;
    case 'chooseTargets': {
      const spec = d.slots[ui.slot];
      for (const t of spec?.legal ?? []) {
        if (t.kind === 'object') h.legalObjects.add(t.id);
        else if (t.kind === 'player') h.legalPlayers.add(t.id);
        else if (t.kind === 'stackItem') h.legalStack.add(t.id);
      }
      for (const slotTargets of ui.targets)
        for (const t of slotTargets) {
          if (t.kind === 'object') h.selectedObjects.add(t.id);
          else if (t.kind === 'player') h.selectedPlayers.add(t.id);
          else if (t.kind === 'stackItem') h.selectedStack.add(t.id);
        }
      break;
    }
    case 'chooseObjects':
      d.candidates.forEach((id) => h.legalObjects.add(id));
      ui.objects.forEach((id) => h.selectedObjects.add(id));
      break;
    case 'declareAttackers':
      d.candidates.forEach((c) => h.legalObjects.add(c.id));
      Object.keys(ui.attacks).forEach((id) => h.selectedObjects.add(Number(id)));
      for (const c of d.candidates) for (const t of c.canAttack) if (typeof t === 'string') h.legalPlayers.add(t);
      if (typeof ui.defender === 'string') h.selectedPlayers.add(ui.defender);
      break;
    case 'declareBlockers':
      if (ui.blocker === null) d.candidates.forEach((c) => h.legalObjects.add(c.id));
      else {
        h.selectedObjects.add(ui.blocker);
        d.candidates.find((c) => c.id === ui.blocker)?.canBlock.forEach((a) => h.legalObjects.add(a));
      }
      ui.blocks.forEach((b) => h.selectedObjects.add(b.blocker));
      break;
    case 'mulligan':
      d.hand.forEach((id) => h.legalObjects.add(id));
      break;
    default:
      break;
  }
  return h;
}

/** Which players / planeswalkers a chosen set of attackers could attack, intersected. */
export function defenderOptions(d: Extract<Decision, { type: 'declareAttackers' }>): (PlayerId | ObjectId)[] {
  const all = new Set<PlayerId | ObjectId>();
  for (const c of d.candidates) for (const t of c.canAttack) all.add(t);
  return Array.from(all);
}
