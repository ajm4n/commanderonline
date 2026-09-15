/** Tiny stdout logger. Silenced with COMMANDER_QUIET=1 (tests). */
let quiet = process.env.COMMANDER_QUIET === '1';

export function setQuiet(q: boolean): void {
  quiet = q;
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export function info(msg: string): void {
  if (!quiet) console.log(`${stamp()} ${msg}`);
}

export function warn(msg: string): void {
  if (!quiet) console.warn(`${stamp()} WARN ${msg}`);
}

export function error(msg: string, err?: unknown): void {
  if (quiet) return;
  const detail = err instanceof Error ? err.message : err !== undefined ? String(err) : '';
  console.error(`${stamp()} ERROR ${msg}${detail ? `: ${detail}` : ''}`);
}
