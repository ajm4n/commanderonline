/** Two browsers: create a room, join by code, ready up, start, and play a land visible to the other player. */
import { launch, newPage, pickSampleDeck, waitFor, act, assert, sleep, state } from './lib.mjs';

const browser = await launch();
const a = await newPage(browser, 'mp-a');
const b = await newPage(browser, 'mp-b');
try {
  await pickSampleDeck(a, 'Alice');
  await pickSampleDeck(b, 'Bob');
  await a.locator('button', { hasText: /^create room/i }).first().click();
  const code = (await a.getByTestId('joincode').innerText({ timeout: 15000 })).trim();
  assert(/^[A-Z0-9]{4,8}$/.test(code), `room code shown: ${code}`);
  await b.getByPlaceholder('Room code').fill(code);
  await b.locator('button', { hasText: /^join$/i }).first().click();
  await b.getByTestId('joincode').waitFor({ timeout: 15000 });
  await a.getByTestId('ready').click();
  await b.getByTestId('ready').click();
  await a.waitForFunction(() => document.body.innerText.includes('Bob'), null, { timeout: 10000 });
  await a.shot('01-lobby');
  await a.getByTestId('start-game').click({ timeout: 15000 });
  const sa = await waitFor(a, (x) => !!x.view, { label: 'A view' });
  const sb = await waitFor(b, (x) => !!x.view, { label: 'B view' });
  assert(sa.view.players.length === 2 && sb.view.players.length === 2, 'both clients see two players');
  const meA = sa.view.players.find((p) => p.id === sa.view.you);
  const oppInB = sb.view.players.find((p) => p.id !== sb.view.you);
  assert(meA.hand?.length === 7 && oppInB.hand === null && oppInB.handCount === 7, "B sees A's hand count but not A's cards");
  // Both keep.
  // The engine asks the (random) starting player first, so drive whichever page holds the decision.
  const kept = new Set();
  const t0 = Date.now();
  while (kept.size < 2 && Date.now() - t0 < 30000) {
    for (const p of [a, b]) {
      const s = await state(p);
      if (s?.decision?.type === 'mulligan') { await act(p, s); kept.add(p); }
      else if (s?.view?.turn?.number >= 1) kept.add(p);
    }
    await sleep(150);
  }
  assert(kept.size === 2, 'both players resolved their mulligan');
  // Play until someone has played a land, driving whichever page has the decision.
  const started = Date.now();
  let landPlayer = null;
  while (Date.now() - started < 90000 && !landPlayer) {
    for (const p of [a, b]) {
      const s = await state(p);
      if (!s?.decision || s.decision.player !== s.view.you) continue;
      const what = await act(p, s);
      console.log(`${p === a ? 'A' : 'B'} t${s.view.turn.number} ${s.view.turn.step}: ${what}`);
      if (what.startsWith('play land')) landPlayer = p;
      await sleep(200);
    }
    await sleep(100);
  }
  assert(landPlayer !== null, 'a land was played through the UI');
  const other = landPlayer === a ? b : a;
  await waitFor(other, (x) => x.view.battlefield.length >= 1, { label: 'other player sees the land' });
  const so = await state(other);
  const land = so.view.objects[so.view.battlefield[0]];
  assert(land && land.controller !== so.view.you && land.types.includes('Land'), `opponent's land is visible to the other browser (${land?.name})`);
  await a.shot('02-board');
  await b.shot('02-board');
  // Reconnect: reload B and make sure it rejoins the game.
  await b.reload({ waitUntil: 'networkidle' });
  const sb2 = await waitFor(b, (x) => !!x.view && x.view.battlefield.length >= 1, { label: 'B reconnected with state', timeout: 30000 });
  assert(sb2.view.players.length === 2, 'B reconnected after reload and got the game view back');
  assert(a.errors.length === 0 && b.errors.length === 0, `no page errors (${[...a.errors, ...b.errors].join(' | ').slice(0, 300)})`);
  console.log('MULTIPLAYER E2E PASSED');
} catch (e) {
  await a.shot('99-error');
  await b.shot('99-error');
  console.log('MULTIPLAYER E2E FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
