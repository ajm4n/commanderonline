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

Current coverage across the 32,169-card Commander-playable pool (Un-set cards are excluded; run
`pnpm cards:coverage` for the live number): 72% of cards fully automated, another 19% partially,
8% manual.

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

Fixed since the first cut: level up and LEVEL blocks, Plot, Warp, Station and STATION blocks (including
Spacecraft "10+ |" rows), Monstrosity, control-changing auras, self cost reductions and affinity, convoke,
delve and improvise payment, a manual "tap exactly these" mana prompt, copies that choose new targets,
rule 613.8 dependency ordering between continuous effects, granted rules text (tokens "with '...'",
"gains 'When this dies, ...'", emblems), spectators and a replay viewer in the client, commander override
in the deck picker, and a Cast options dialog that actually casts (alternative costs such as warp, modal
spells, X spells, adventures and modal double-faced cards are covered by a browser test).

The oracle-text compiler is free and offline (regex templates, no paid API). Coverage over the full
Commander-playable pool is tracked by `pnpm cards:coverage`; at the time of writing it automates 72% of
cards completely and another 19% partially. Cards it cannot fully script still play: unscripted
sentences become a prompt at the right moment and the player resolves them by hand (Untap-style).

Still open, roughly in order of value:

- **Compiler long tail.** The remaining templates are a very flat distribution (the most common
  unhandled line appears on 34 of 33,574 cards). Recent rounds targeted discard decks (Tinybones,
  Bone Miser, Waste Not, Syr Konrad, Painful Quandary, ...), combat restrictions, reveals and
  planeswalker emblems. Keep running the coverage report and adding templates by frequency; the
  `test/tinybones.test.ts` suite shows how to prove a deck's cards end to end.
- **Keyword actions without engine support.** Discover, connive on non-self objects, incubate,
  multikicker, overload, replicate, clash, day/night, Attractions and stickers, firebending and other
  Un-/Universes Beyond mechanics either compile to a prompt or not at all.
- **Text-changing and "choose a name" effects.** Named-card restrictions (Meddling Mage), chosen-type
  anthems and "becomes the basic land type of your choice" are prompts, not automation.
- **Modal double-faced back faces and flip cards** work for casting and playing lands, but transform
  and flip triggers on the back face are only as good as the compiler's handling of that face's text.
- **Moxfield URL import** only works for user agents Moxfield has approved (Cloudflare returns
  403 to everything else, browser-like or not). Use Archidekt links, which import directly, or
  paste Moxfield's "Export" text. If you get a user agent approved by Moxfield, set
  `DECK_IMPORT_USER_AGENT` on the server and Moxfield links work too.
- **Hosting.** GitHub Pages needs *Settings → Pages → Source: GitHub Actions* enabled once; the
  Render/Fly/Docker configs run the full multiplayer server.
