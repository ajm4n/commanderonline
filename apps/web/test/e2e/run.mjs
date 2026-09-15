/** Runs every e2e script in sequence. Requires a server at E2E_URL serving the built client. */
import { spawnSync } from 'node:child_process';
let failed = false;
for (const f of ['solo.mjs', 'multiplayer.mjs', 'castoptions.mjs']) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [new URL(f, import.meta.url).pathname], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
