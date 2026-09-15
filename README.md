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
41% of cards fully automated, another 36% partially, 23% manual.

## Play it

- **Browser-only (solo / goldfish):** the client is deployed to GitHub Pages from `main` by
  `.github/workflows/pages.yml`: https://ajm4n.github.io/commanderonline/ . Everything runs in the
  tab; cards and images come from Scryfall. Multiplayer needs a server, so the "Create room" panel
  shows the server as offline there.
- **Full stack (multiplayer rooms, URL import):** one container serves the API, the WebSocket
  server and the built client, with the Scryfall card pool fetched at build time.
  - Render: fork the repo, then https://render.com/deploy?repo=https://github.com/ajm4n/commanderonline
    (the `render.yaml` blueprint uses the Dockerfile; the free tier works, it just sleeps when idle).
  - Fly.io: `fly launch --copy-config --no-deploy && fly deploy` using the included `fly.toml`.
  - Anywhere with Docker: `docker build -t commander . && docker run -p 8787:8787 commander`.

## Development

```bash
pnpm -r typecheck
pnpm -r test              # engine, cards, deck-import and server tests
pnpm cards:coverage       # compiler coverage report with the most common unhandled lines
pnpm --filter @commander/web e2e   # browser tests: needs a running server (E2E_URL, default :8790)
```

The browser tests in `apps/web/test/e2e` drive the real client with Playwright: a solo game
played for several turns through clicks (lands, spells, targets, attacks), and a two-browser
multiplayer game (room code, ready, start, hidden information, reconnect). Set `PW_CHROMIUM` to
your Chromium binary if it is not at the default path.

Adding automation for a card: write a `CardScript` in `packages/cards/src/scripts/index.ts`
(hand scripts win over compiled ones), or teach the compiler a new template in
`packages/cards/src/compiler`. The coverage report lists the templates that would pay off most.

See `ARCHITECTURE.md` for the engine design.

## Known gaps and what's next

Fixed since the first cut: level up and LEVEL blocks, Plot, Warp, Station and STATION blocks,
Monstrosity, control-changing auras ("You control enchanted creature"), self cost reductions
("costs {1} less to cast for each ...", affinity), and convoke, delve and improvise payment. The
client and server are covered by browser tests (multi-turn solo play and a two-browser game).

Still open, roughly in order of value:

- **Compiler long tail.** About 23% of the pool has no automation and 36% is partial. The
  coverage report ranks what is left; the biggest remaining templates are "target player reveals
  their hand, you choose a card, they discard it", Class cards, "can't be blocked by creatures
  with power N or less", Saga transform-and-return, dice rolls, the Ring and the initiative.
- **Mana payment is auto-tap.** The engine picks lands for you (Arena-style); there is no manual
  "tap exactly these" prompt yet, and hybrid or phyrexian edge cases pay the simplest way.
- **Copies choose no new targets.** Copying a spell keeps the original's targets.
- **Layer edge cases.** Dependencies between continuous effects (rule 613.8) are ordered by
  timestamp only; copy effects of copies and some CDAs are approximations.
- **Tokens with granted text.** "Create a token with 'Whenever ...'" tokens carry the text but the
  compiler does not script it until that text is a known template.
- **No spectators or replays UI.** Games are replayable from history in code, not in the client.
