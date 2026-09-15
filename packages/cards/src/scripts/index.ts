/** Hand-written scripts for cards the compiler can't express well. Keyed by card name. */
import type { CardScript } from '@commander/engine';

export const HAND_SCRIPTS: Record<string, CardScript> = {};

/**
 * Register additional hand-written scripts (for example a community scripts JSON file) at startup.
 */
export function registerScripts(scripts: Record<string, CardScript>): number {
  let n = 0;
  for (const [name, s] of Object.entries(scripts)) {
    if (!HAND_SCRIPTS[name]) n++;
    HAND_SCRIPTS[name] = s;
  }
  return n;
}
