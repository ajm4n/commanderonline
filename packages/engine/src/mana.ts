import { type Color, type ManaColor, type ManaPool, emptyPool, COLORS } from './types.js';

/** One symbol of a mana cost. */
export type ManaSymbol =
  | { kind: 'generic'; amount: number }
  | { kind: 'color'; color: ManaColor }
  | { kind: 'hybrid'; options: ManaColor[] }
  | { kind: 'monoHybrid'; color: Color } // {2/W}
  | { kind: 'phyrexian'; color: Color } // {W/P}
  | { kind: 'x' }
  | { kind: 'snow' };

export interface ManaCost {
  symbols: ManaSymbol[];
  /** Total number of X symbols. */
  xCount: number;
}

const SYMBOL_RE = /\{([^}]+)\}/g;

export function parseManaCost(cost: string | undefined): ManaCost {
  const symbols: ManaSymbol[] = [];
  let xCount = 0;
  if (!cost) return { symbols, xCount };
  for (const m of cost.matchAll(SYMBOL_RE)) {
    const s = m[1].toUpperCase();
    if (/^\d+$/.test(s)) {
      const n = parseInt(s, 10);
      if (n > 0) symbols.push({ kind: 'generic', amount: n });
    } else if (s === 'X' || s === 'Y' || s === 'Z') {
      xCount++;
      symbols.push({ kind: 'x' });
    } else if (s === 'S') {
      symbols.push({ kind: 'snow' });
    } else if (s.length === 1 && 'WUBRGC'.includes(s)) {
      symbols.push({ kind: 'color', color: s as ManaColor });
    } else if (/^2\/[WUBRG]$/.test(s)) {
      symbols.push({ kind: 'monoHybrid', color: s[2] as Color });
    } else if (/^[WUBRG]\/P$/.test(s)) {
      symbols.push({ kind: 'phyrexian', color: s[0] as Color });
    } else if (/^[WUBRGC](\/[WUBRGC])+$/.test(s)) {
      symbols.push({ kind: 'hybrid', options: s.split('/') as ManaColor[] });
    } else if (/^[WUBRG]\/[WUBRG]\/P$/.test(s)) {
      // hybrid phyrexian: treat as hybrid with phyrexian option
      symbols.push({ kind: 'hybrid', options: [s[0] as ManaColor, s[2] as ManaColor] });
    }
    // Unknown symbols ignored.
  }
  return { symbols, xCount };
}

export function manaValue(cost: string | undefined, x = 0): number {
  const c = parseManaCost(cost);
  let total = 0;
  for (const s of c.symbols) {
    if (s.kind === 'generic') total += s.amount;
    else if (s.kind === 'x') total += x;
    else if (s.kind === 'monoHybrid') total += 2;
    else total += 1;
  }
  return total;
}

/** Colors of a mana cost (for color identity, "colors of mana spent"). */
export function costColors(cost: string | undefined): Color[] {
  const set = new Set<Color>();
  for (const s of parseManaCost(cost).symbols) {
    if (s.kind === 'color' && s.color !== 'C') set.add(s.color);
    if (s.kind === 'hybrid') s.options.forEach((o) => o !== 'C' && set.add(o as Color));
    if (s.kind === 'monoHybrid' || s.kind === 'phyrexian') set.add(s.color);
  }
  return COLORS.filter((c) => set.has(c));
}

export function formatCost(cost: ManaCost, x?: number): string {
  return cost.symbols
    .map((s) => {
      switch (s.kind) {
        case 'generic':
          return `{${s.amount}}`;
        case 'color':
          return `{${s.color}}`;
        case 'hybrid':
          return `{${s.options.join('/')}}`;
        case 'monoHybrid':
          return `{2/${s.color}}`;
        case 'phyrexian':
          return `{${s.color}/P}`;
        case 'x':
          return x !== undefined ? `{${x}}` : '{X}';
        case 'snow':
          return '{S}';
      }
    })
    .join('');
}

/** Add generic mana to a cost (cost increases) or reduce it. Returns new cost. */
/** Remove (times < 0) or add (times > 0) the given colored symbols from a cost, |times| times. */
export function adjustSymbols(cost: ManaCost, symbols: string, times: number): ManaCost {
  const parsed = parseManaCost(symbols).symbols;
  const out: ManaSymbol[] = [...cost.symbols];
  for (let i = 0; i < Math.abs(times); i++) {
    for (const sym of parsed) {
      if (times > 0) out.push(sym);
      else {
        const idx = out.findIndex((s) => JSON.stringify(s) === JSON.stringify(sym));
        if (idx >= 0) out.splice(idx, 1);
        else if (sym.kind === 'color' || sym.kind === 'generic') {
          // No such colored symbol left: reduce generic instead (rule 601.2f lets reductions of a color only remove that color, so this is a fallback).
          const g = out.findIndex((s) => s.kind === 'generic');
          if (g >= 0) (out[g] as { amount: number }).amount = Math.max(0, (out[g] as { amount: number }).amount - (sym.kind === 'generic' ? sym.amount : 1));
        }
      }
    }
  }
  return { symbols: out.filter((s) => !(s.kind === 'generic' && s.amount <= 0)), xCount: cost.xCount };
}

export function adjustGeneric(cost: ManaCost, delta: number): ManaCost {
  const symbols: ManaSymbol[] = cost.symbols.filter((s) => s.kind !== 'generic');
  const existing = cost.symbols.filter((s) => s.kind === 'generic').reduce((a, s) => a + (s as { amount: number }).amount, 0);
  const n = Math.max(0, existing + delta);
  if (n > 0) symbols.unshift({ kind: 'generic', amount: n });
  return { symbols, xCount: cost.xCount };
}

export function poolTotal(p: ManaPool): number {
  return p.W + p.U + p.B + p.R + p.G + p.C;
}

export function addToPool(p: ManaPool, color: ManaColor, n = 1) {
  p[color] += n;
}

export function clonePool(p: ManaPool): ManaPool {
  return { ...p };
}

/**
 * A mana source that could produce one of several colors when tapped.
 * `produces` lists alternatives, e.g. [['G'],['W']] for a dual land.
 */
export interface ManaSourceOption {
  id: number;
  /** Each alternative is the set of mana produced by one activation. */
  alternatives: ManaColor[][];
  /** Penalty for using this source (prefer basics / single-color sources first). */
  priority: number;
  /** Mana from this source can only pay generic costs (delve, improvise). */
  genericOnly?: boolean;
  /** Virtual sources created by casting keywords. */
  kind?: 'mana' | 'convoke' | 'improvise' | 'delve';
}

export interface Payment {
  tap: number[]; // source ids in order
  /** For each tapped source, which alternative index was chosen. */
  alternatives: number[];
  fromPool: ManaPool;
  /** Life paid for phyrexian mana. */
  lifePaid: number;
}

/**
 * Concrete requirement list after expanding a cost with a chosen X.
 * Each entry is the set of colors that can satisfy it ('any' = generic).
 */
export function expandRequirements(cost: ManaCost, x: number, allowPhyrexianLife = true): { options: ManaColor[] | 'any'; phyrexian?: Color; monoHybridGeneric?: number }[] {
  const reqs: { options: ManaColor[] | 'any'; phyrexian?: Color; monoHybridGeneric?: number }[] = [];
  for (const s of cost.symbols) {
    switch (s.kind) {
      case 'generic':
        for (let i = 0; i < s.amount; i++) reqs.push({ options: 'any' });
        break;
      case 'x':
        for (let i = 0; i < x; i++) reqs.push({ options: 'any' });
        break;
      case 'color':
        reqs.push({ options: [s.color] });
        break;
      case 'hybrid':
        reqs.push({ options: s.options });
        break;
      case 'monoHybrid':
        reqs.push({ options: [s.color], monoHybridGeneric: 2 });
        break;
      case 'phyrexian':
        reqs.push({ options: [s.color], phyrexian: allowPhyrexianLife ? s.color : undefined });
        break;
      case 'snow':
        reqs.push({ options: 'any' });
        break;
    }
  }
  // Colored requirements first so generic soaks up leftovers.
  reqs.sort((a, b) => (a.options === 'any' ? 1 : 0) - (b.options === 'any' ? 1 : 0));
  return reqs;
}

/**
 * Find a way to pay `cost` using the mana pool first, then tapping sources.
 * Small backtracking search; Commander boards rarely exceed ~20 sources so
 * this is fast in practice. Returns null if unpayable.
 */
export function solvePayment(cost: ManaCost, x: number, pool: ManaPool, sources: ManaSourceOption[], opts: { payLifeForPhyrexian?: boolean; life?: number } = {}): Payment | null {
  // {2/W} is paid with either {W} or two generic (CR 107.4e): try each combination, colour first.
  const mono = cost.symbols.map((s, i) => (s.kind === 'monoHybrid' ? i : -1)).filter((i) => i >= 0);
  if (!mono.length) return solvePaymentExact(cost, x, pool, sources, opts);
  for (let mask = 0; mask < 1 << mono.length; mask++) {
    const symbols: ManaSymbol[] = cost.symbols.map((s, i) => {
      const k = mono.indexOf(i);
      if (k < 0 || s.kind !== 'monoHybrid') return s;
      return (mask >> k) & 1 ? { kind: 'generic', amount: 2 } : { kind: 'color', color: s.color as ManaColor };
    });
    const sol = solvePaymentExact({ symbols, xCount: cost.xCount }, x, pool, sources, opts);
    if (sol) return sol;
  }
  return null;
}

function solvePaymentExact(cost: ManaCost, x: number, pool: ManaPool, sources: ManaSourceOption[], opts: { payLifeForPhyrexian?: boolean; life?: number } = {}): Payment | null {
  const reqs = expandRequirements(cost, x, opts.payLifeForPhyrexian ?? false);
  const poolLeft = clonePool(pool);
  const fromPool = emptyPool();
  const remaining: typeof reqs = [];

  // 1. Pay from pool greedily: colored requirements that can only be met one way first.
  for (const r of reqs) {
    if (r.options === 'any') {
      remaining.push(r);
      continue;
    }
    const c = r.options.find((o) => poolLeft[o] > 0);
    if (c) {
      poolLeft[c]--;
      fromPool[c]++;
    } else remaining.push(r);
  }
  const generic = remaining.filter((r) => r.options === 'any');
  const colored = remaining.filter((r) => r.options !== 'any');
  // Generic from pool.
  for (const g of generic) {
    const c = (['C', 'W', 'U', 'B', 'R', 'G'] as ManaColor[]).find((o) => poolLeft[o] > 0);
    if (c) {
      poolLeft[c]--;
      fromPool[c]++;
      g.options = [] as ManaColor[]; // mark satisfied
    }
  }
  const todo = [...colored, ...generic.filter((g) => g.options === 'any')];
  if (todo.length === 0) return { tap: [], alternatives: [], fromPool, lifePaid: 0 };

  // 2. Backtracking over sources. Sort: fewest alternatives first, then priority.
  const sorted = [...sources].sort((a, b) => a.alternatives.length - b.alternatives.length || a.priority - b.priority);
  const need = todo.length;
  const tap: number[] = [];
  const alts: number[] = [];
  let bestSolution: { tap: number[]; alts: number[] } | null = null;

  // Requirements bitmask approach: assign each source to one requirement.
  const satisfied = new Array(todo.length).fill(false);

  function tryAssign(sourceIdx: number, satisfiedCount: number): boolean {
    if (satisfiedCount === need) {
      bestSolution = { tap: [...tap], alts: [...alts] };
      return true;
    }
    if (sourceIdx >= sorted.length) return false;
    if (sorted.length - sourceIdx < need - satisfiedCount) return false; // not enough left
    const src = sorted[sourceIdx];
    // Option A: use this source for some unsatisfied requirement.
    for (let ai = 0; ai < src.alternatives.length; ai++) {
      const produced = src.alternatives[ai];
      // Sources that produce multiple mana per tap (e.g. Sol Ring) can satisfy several reqs.
      const used: number[] = [];
      for (const color of produced) {
        // find an unsatisfied colored req first, else generic
        let idx = src.genericOnly ? -1 : todo.findIndex((r, i) => !satisfied[i] && r.options !== 'any' && (r.options as ManaColor[]).includes(color));
        if (idx === -1) idx = todo.findIndex((r, i) => !satisfied[i] && r.options === 'any');
        if (idx === -1) break;
        satisfied[idx] = true;
        used.push(idx);
      }
      if (used.length > 0) {
        tap.push(src.id);
        alts.push(ai);
        if (tryAssign(sourceIdx + 1, satisfiedCount + used.length)) return true;
        tap.pop();
        alts.pop();
      }
      for (const u of used) satisfied[u] = false;
    }
    // Option B: skip this source.
    return tryAssign(sourceIdx + 1, satisfiedCount);
  }

  tryAssign(0, 0);
  if (!bestSolution) return null;
  const sol = bestSolution as { tap: number[]; alts: number[] };
  return { tap: sol.tap, alternatives: sol.alts, fromPool, lifePaid: 0 };
}

/** Can the given cost be paid at all with pool + sources? */
export function canPay(cost: ManaCost, x: number, pool: ManaPool, sources: ManaSourceOption[]): boolean {
  return solvePayment(cost, x, pool, sources) !== null;
}

/** Maximum X payable given resources (for "X" spells UI). Linear scan. */
export function maxX(cost: ManaCost, pool: ManaPool, sources: ManaSourceOption[]): number {
  let x = 0;
  while (x < 40 && canPay(cost, x + 1, pool, sources)) x++;
  return x;
}

/** Parse "Add {G}{G}." style text into produced mana alternatives. */
export function parseAddManaText(text: string): ManaColor[][] {
  const alts: ManaColor[][] = [];
  // "Add {G} or {W}" / "Add {W}, {U}, or {B}" / "Add {C}{C}" / "Add one mana of any color"
  const m = text.match(/Add ([^.]+)\./i) ?? text.match(/Add ([^.]+)$/i);
  if (!m) return alts;
  const body = m[1];
  if (/mana of any color/i.test(body)) {
    const count = /two mana/i.test(body) ? 2 : /three mana/i.test(body) ? 3 : 1;
    for (const c of COLORS) alts.push(new Array(count).fill(c));
    return alts;
  }
  if (/mana of any one color/i.test(body) || /mana in any combination of colors/i.test(body)) {
    const count = /two/i.test(body) ? 2 : /three/i.test(body) ? 3 : 1;
    for (const c of COLORS) alts.push(new Array(count).fill(c));
    return alts;
  }
  // Split alternatives on " or "
  const parts = body.split(/,? or |, /i);
  for (const part of parts) {
    const syms = [...part.matchAll(/\{([WUBRGC])\}/g)].map((x) => x[1] as ManaColor);
    if (syms.length) alts.push(syms);
  }
  return alts;
}
