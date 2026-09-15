# Architecture

## Engine (`packages/engine`)

The engine is a single `Game` class that owns all state and drives the rules. It has no I/O and
no randomness other than a seeded PRNG, so a game is fully reproducible from its inputs and the
list of player responses (`Game.replay`).

### Control flow: generators

Every procedure that may need a player decision is a generator. It `yield`s a `Decision` and
receives a `Response`. `Game.submit(player, response)` resumes the main loop. This lets a nested
choice (a target inside a "may" inside a trigger inside a spell resolution) pause and resume
without any explicit state machine.

`game.pending` is the current decision, or `null`. The 13 decision types are in `types.ts`.

### Main loop

`play` → mulligans → `takeTurn` per player → `doStep` per step → `priorityRound`.

Before a player receives priority the engine runs state-based actions and puts pending triggers
on the stack in APNAP order (asking a player to order their own when it matters). When all
players pass in succession the top of the stack resolves, or the step ends if the stack is empty.
Players with nothing legal to do auto-pass, which is what makes the game feel like Arena rather
than a priority-passing chore.

### Objects, zones, events

`moveObject` is the single place objects change zones. It snapshots last-known information,
resets object state (a permanent is a new object when it changes zones), handles tokens ceasing
to exist, attached objects, "until this leaves" effects and self-replacement effects, and emits
events. `emit` collects triggered abilities from every object whose script listens for that
event, including look-back triggers for objects that just left the battlefield.

### Characteristics and layers

`computeCharacteristics` applies continuous effects in layer order (copy, control, types,
colors, abilities, P/T set, P/T modify including counters, P/T switch) with timestamps.
Static abilities on the battlefield are recomputed each time; effects from resolved spells are
stored with a duration and expire at the right moment. Results are cached per state version.

### Scripts

A `CardScript` (in `script.ts`) is a declarative description of a card: triggered, activated,
static and spell abilities, replacement effects, targets, costs and effects. Effects are a small
vocabulary (draw, damage, destroy, create token, counters, pump, search, and so on) with `Ref`s
that resolve to objects or players at execution time (`target`, `self`, `eachOpponent`,
`triggerObject`, `all` with a filter, ...). `effects.ts` interprets them. The engine never runs
card-specific code.

Anything a script cannot express becomes a `manual` effect: the player gets a prompt with the
text at exactly the right moment and resolves it with manual actions.

### Views

`viewFor(game, player)` produces the redacted state a client may see: own hand, counts for
hidden zones, computed characteristics for every visible object, the stack, the log, and the
pending decision only if it belongs to that player.

## Compiler (`packages/cards/src/compiler`)

Oracle text → `CardScript`, per line:

1. `text.ts` normalizes: card name to `~`, reminder text stripped, contractions expanded,
   "enters the battlefield" → "enters".
2. Keyword lines are recognized and left to the engine (flying, deathtouch, ward, cycling...).
3. `triggers.ts` parses trigger heads ("Whenever ~ deals combat damage to a player, ...") into an
   event plus filter; `splitTriggerRest` peels off "you may" and intervening "if" clauses.
4. `costs.ts` parses activated-ability costs; loyalty abilities and saga chapters are handled in
   the orchestrator.
5. `effects.ts` parses effect sentences with an ordered list of regex patterns. `nouns.ts` turns
   noun phrases ("target nonland permanent an opponent controls") into `ObjectFilter`s and
   target specs; `amounts.ts` handles "X", "the number of creatures you control", "its power".
6. `statics.ts` handles anthems, keyword grants, rules ("can't block"), cost changes, enters-tapped
   and doubling replacements.

Lines the compiler cannot parse are recorded in `unhandledText` and become manual prompts.
`scripts/coverage.ts` compiles the whole pool and lists the most common unhandled lines so work
goes where it matters.

## Server (`apps/server`)

In-memory rooms with a 6-character code, seats with reconnect tokens, bot seats that answer
decisions with sensible defaults, one `Game` per room. After every state change each connected
human receives only their own `viewFor` view. HTTP API for deck import (URL via
`deck-import`, text), card search and name resolution against the Scryfall bulk data.

## Client (`apps/web`)

React + Vite. A `GameConnection` interface has two implementations: `WebSocketConnection`
(multiplayer) and `LocalConnection` (a `Game` running in the browser with bot opponents). The
board renders a `GameView` and never knows which mode it is in. Card names are resolved to
`CardData` through Scryfall's collection API in the browser, with the server as fallback.
