import type { Step, Phase, Target, ManaColor } from '@commander/engine';
import type { GameView } from '@commander/engine';

export const STEP_ORDER: Step[] = ['untap', 'upkeep', 'draw', 'main1', 'beginCombat', 'declareAttackers', 'declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat', 'main2', 'end', 'cleanup'];

export const STEP_LABEL: Record<Step, string> = {
  untap: 'Untap',
  upkeep: 'Upkeep',
  draw: 'Draw',
  main1: 'Main 1',
  beginCombat: 'Begin combat',
  declareAttackers: 'Attackers',
  declareBlockers: 'Blockers',
  firstStrikeDamage: 'First strike',
  combatDamage: 'Damage',
  endCombat: 'End combat',
  main2: 'Main 2',
  end: 'End step',
  cleanup: 'Cleanup',
};

export const STEP_SHORT: Record<Step, string> = {
  untap: 'UT',
  upkeep: 'UP',
  draw: 'DR',
  main1: 'M1',
  beginCombat: 'BC',
  declareAttackers: 'DA',
  declareBlockers: 'DB',
  firstStrikeDamage: 'FS',
  combatDamage: 'CD',
  endCombat: 'EC',
  main2: 'M2',
  end: 'END',
  cleanup: 'CL',
};

export const PHASE_OF_STEP: Record<Step, Phase> = {
  untap: 'beginning',
  upkeep: 'beginning',
  draw: 'beginning',
  main1: 'precombatMain',
  beginCombat: 'combat',
  declareAttackers: 'combat',
  declareBlockers: 'combat',
  firstStrikeDamage: 'combat',
  combatDamage: 'combat',
  endCombat: 'combat',
  main2: 'postcombatMain',
  end: 'ending',
  cleanup: 'ending',
};

export const MANA_COLORS: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];
export const MANA_NAMES: Record<ManaColor, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' };

/** Render a mana cost string like "{2}{G}{G}" as a list of symbol tokens. */
export function manaSymbols(cost: string): string[] {
  if (!cost) return [];
  const out: string[] = [];
  for (const m of cost.matchAll(/\{([^}]+)\}/g)) out.push(m[1]);
  return out;
}

export function playerName(view: GameView | null, id: string | null | undefined): string {
  if (!view || !id) return '?';
  return view.players.find((p) => p.id === id)?.name ?? id;
}

export function objectName(view: GameView | null, id: number): string {
  const o = view?.objects[id];
  if (!o) return `#${id}`;
  return o.hidden ? 'a face-down card' : o.name || `#${id}`;
}

export function targetLabel(view: GameView | null, t: Target): string {
  switch (t.kind) {
    case 'object':
      return objectName(view, t.id);
    case 'player':
      return playerName(view, t.id);
    case 'stackItem': {
      const s = view?.stack.find((x) => x.id === t.id);
      return s ? `${s.sourceName} (stack)` : `stack item #${t.id}`;
    }
    default:
      return 'nothing';
  }
}

export function sameTarget(a: Target, b: Target): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'none' || b.kind === 'none') return true;
  return (a as { id: unknown }).id === (b as { id: unknown }).id;
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function coverageLabel(c: 'full' | 'partial' | 'none'): string {
  return c === 'full' ? 'Automated' : c === 'partial' ? 'Partially automated' : 'Manual';
}

export function plural(n: number, word: string, pluralWord = word + 's'): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}
