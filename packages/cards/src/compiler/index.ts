/**
 * Oracle text → CardScript compiler. Turns templated rules text into
 * executable scripts so the engine can automate cards nobody hand-scripted.
 * (Full implementation follows; this stub keeps the API stable.)
 */
import type { CardData, CardScript } from '@commander/engine';

export interface CompileResult {
  script: CardScript;
  /** Oracle lines that were fully compiled. */
  compiledLines: string[];
  /** Oracle lines the compiler could not handle. */
  unhandledLines: string[];
}

export function compileCard(card: CardData): CompileResult {
  const lines = card.oracleText ? card.oracleText.split('\n') : [];
  return { script: { name: card.name, abilities: [], coverage: 'none', origin: 'compiled', unhandledText: lines }, compiledLines: [], unhandledLines: lines };
}
