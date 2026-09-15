# Commander Online — notes for coding agents

pnpm monorepo, TypeScript ESM, Node 22, vitest. Read `ARCHITECTURE.md` first.

- `pnpm -r typecheck && pnpm -r test` must stay green. Engine tests are in `packages/engine/test`
  (use the `Driver` helper to play scripted games), compiler tests in `packages/cards/test`.
- The engine (`packages/engine`) is pure and deterministic: no I/O, no `Math.random`, no Date.
  Every player-facing choice goes through `Game.ask` (a generator yielding a `Decision`).
- Card behaviour lives in scripts, never in engine code. Hand scripts go in
  `packages/cards/src/scripts/index.ts`; templated behaviour goes in the compiler under
  `packages/cards/src/compiler`. Run `pnpm cards:coverage` after compiler changes and check
  the full/partial/none numbers did not regress.
- Scryfall bulk data (`packages/cards/data/scryfall/`) is gitignored; `pnpm cards:fetch` gets it.
  Tests use `packages/cards/data/fixtures/sample-cards.json` (real oracle text; keep it accurate).
- Protocol changes go in `packages/protocol/src/index.ts` and must be reflected in both
  `apps/server/src/rooms.ts` and `apps/web/src/lib/connection.ts`.
- Never send another player's hand or library contents to a client; use `viewFor`.
