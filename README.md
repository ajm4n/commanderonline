# Commander Online

Rules-enforced Magic: The Gathering Commander, played in the browser. It plays like Arena
(auto untap and draw, triggers go on the stack by themselves, priority passing, targeting
prompts, combat math, state-based actions, commander tax and commander damage) for two to six
players, and falls back to Untap-style manual controls for anything the engine cannot automate
yet. Every card in the Commander pool is playable on day one; automation coverage grows as the
oracle-text compiler learns more templates.

Card data and images come from Scryfall. This is a free, non-commercial fan project under the
Wizards of the Coast Fan Content Policy.

## Quick start

```bash
pnpm install
pnpm cards:fetch          # downloads the Scryfall oracle bulk data (~20 MB) once
pnpm --filter @commander/server dev   # game server on http://localhost:8787
pnpm --filter @commander/web dev      # client on http://localhost:5173 (proxies /api and /ws)
```

Solo mode needs no server at all: the rules engine runs in the browser and cards are resolved
straight from Scryfall's API. The server is for multiplayer rooms, Moxfield/Archidekt URL import
and as a fallback card database when Scryfall is unreachable.

For a single production process: `pnpm --filter @commander/web build`, then start the server; it
serves `apps/web/dist` and the API from one port.

## What is here

| Package | What it does |
|---|---|
| `packages/engine` | The rules engine. Pure, deterministic TypeScript, no I/O. Turn structure, priority, the stack, triggered abilities (APNAP ordering), the layer system, combat, state-based actions, commander rules, a script DSL for card behaviour, and per-player redacted views. Control flow uses generators so any effect can pause to ask a player a question. |
| `packages/cards` | Scryfall ingestion and the oracle-text compiler that turns templated rules text into engine scripts. `pnpm cards:coverage` reports how much of the pool is automated. |
| `packages/deck-import` | Moxfield, Archidekt and plain-text decklist parsing. |
| `packages/protocol` | The WebSocket message contract between server and client. |
| `apps/server` | Node game server: rooms, reconnection, bots, per-player views, deck import and card search API. |
| `apps/web` | React client: deck picker, lobby, the game board, every decision prompt, manual-mode tools, solo mode. |

## How automation works

Each card gets a script: a hand-written one if it exists, otherwise one compiled from its oracle
text. A script's `coverage` is `full`, `partial` or `none`, and the client shows it on every
card so you know what will happen by itself and what you will do by hand.

- **Full**: the engine runs the card. Triggers fire at the right moment, targets are prompted for,
  effects resolve.
- **Partial**: the parts the compiler understood are automated. Anything else shows up as a prompt
  with the card's text at the right time, and you resolve it with the manual tools.
- **None**: the card is still a legal spell or permanent with correct types, P/T and keywords, and
  you resolve its text by hand.

Right-click any card for manual controls: tap, move to any zone, counters, damage, control,
transform. Life, poison and commander damage are editable, and there are token, mana, draw, mill
and shuffle tools. Manual actions are recorded in the same history as everything else, so games
stay replayable.

Current coverage across the 33,574-card pool (run `pnpm cards:coverage` for the live number):
about 40% of cards fully automated, another 36% partially, 24% manual.

## Development

```bash
pnpm -r typecheck
pnpm -r test              # engine, cards, deck-import and server tests
pnpm cards:coverage       # compiler coverage report with the most common unhandled lines
```

Adding automation for a card: write a `CardScript` in `packages/cards/src/scripts/index.ts`
(hand scripts win over compiled ones), or teach the compiler a new template in
`packages/cards/src/compiler`. The coverage report lists the templates that would pay off most.

See `ARCHITECTURE.md` for the engine design.
