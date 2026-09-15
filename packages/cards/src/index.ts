export * from './scryfall.js';
export * from './db.js';
export { compileCard, type CompileResult } from './compiler/index.js';
export { HAND_SCRIPTS, registerScripts } from './scripts/index.js';
import type { CardData, CardScript } from '@commander/engine';
import { compileCard } from './compiler/index.js';
import { HAND_SCRIPTS } from './scripts/index.js';

const cache = new Map<string, CardScript>();

/**
 * The script provider used by every game: hand-written script if one exists,
 * otherwise the compiled script from oracle text. Pass this to `new Game(...)`.
 */
export function scriptFor(card: CardData): CardScript {
  const key = card.oracleId || card.name;
  const hit = cache.get(key);
  if (hit) return hit;
  const hand = HAND_SCRIPTS[card.name];
  let script: CardScript;
  if (hand) script = hand;
  else {
    const r = compileCard(card);
    script = r.script;
  }
  // Multi-face cards: compile each extra face too.
  if (card.faces && card.faces.length > 1 && !script.faces) {
    script = {
      ...script,
      faces: card.faces.slice(1).map((f) => {
        const faceCard: CardData = { ...card, ...f, faces: undefined };
        return HAND_SCRIPTS[f.name] ?? compileCard(faceCard).script;
      }),
    };
  }
  cache.set(key, script);
  return script;
}
