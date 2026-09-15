/** Cast options: alternative costs (warp), modal spells, X spells, adventure and MDFC face choices, all through the UI. */
import { launch, newPage, waitFor, act, assert, sleep, state, clickCard, URL } from './lib.mjs';

const DECK = `Commander
1 Prosper, Tome-Bound

Deck
1 Red Tiger Mechan
1 Kolaghan's Command
1 Banefire
1 Bonecrusher Giant // Stomp
1 Valakut Awakening // Valakut Stoneforge
1 Abrade
20 Mountain
14 Swamp`;

const browser = await launch();
const page = await newPage(browser, 'castopts');
const respond = (r) => page.evaluate((r) => window.__co.respond(r), r);
const manual = (action) => respond({ type: 'manual', action });
const me = (s) => s.view.players.find((p) => p.id === s.view.you);
const opp = (s) => s.view.players.find((p) => p.id !== s.view.you);
const inHand = (s, name) => (me(s).hand ?? []).find((id) => s.view.objects[id]?.name?.startsWith(name));
const myPriority = (x) => x.decision?.type === 'priority' && x.decision.player === x.view.you;
/** Pass priority until the stack is empty again (the bot passes on its own). */
async function resolveStack() {
  for (let i = 0; i < 20; i++) {
    const s = await waitFor(page, (x) => !!x.decision && x.decision.player === x.view.you, { label: 'my decision while resolving', timeout: 20000 });
    if (s.view.stack.length === 0 && s.decision.type === 'priority') return s;
    if (s.decision.type === 'priority') await page.getByTestId('pass').click();
    else await act(page, s);
    await sleep(150);
  }
  throw new Error('stack never emptied');
}
try {
  await page.goto(`${URL}?seed=7&botDelay=50`, { waitUntil: 'networkidle' });
  await page.getByPlaceholder('Planeswalker').fill('AJ');
  await page.locator('button', { hasText: /pick a deck|deck/i }).first().click();
  await page.getByPlaceholder(/moxfield/i).fill(DECK);
  await page.locator('button', { hasText: /^load deck/i }).first().click();
  await page.waitForFunction(() => /use this deck/i.test(document.body.innerText), null, { timeout: 120000 });
  assert(/Prosper, Tome-Bound/.test(await page.innerText('body')), 'pasted list resolved with Prosper as commander');
  await page.locator('button', { hasText: /^use this deck/i }).first().click();
  await page.waitForTimeout(300);
  await page.locator('button', { hasText: /start solo/i }).first().click();
  await page.getByTestId('start-game').click({ timeout: 15000 });

  // Get to our own first main phase with priority.
  let s;
  for (let i = 0; i < 40; i++) {
    s = await waitFor(page, (x) => !!x.decision && x.decision.player === x.view.you, { label: 'my decision' });
    if (myPriority(s) && s.view.turn.step === 'main1' && me(s).isActive && s.view.stack.length === 0) break;
    await act(page, s);
    await sleep(100);
  }
  assert(myPriority(s) && s.view.turn.step === 'main1', `reached our main phase (turn ${s.view.turn.number})`);

  // Load the hand and the mana pool by hand so every test card is castable right now.
  await manual({ kind: 'draw', count: me(s).libraryCount }); // the whole library; one more would lose the game
  await manual({ kind: 'addMana', color: 'R', amount: 40 });
  await manual({ kind: 'addMana', color: 'B', amount: 10 });
  s = await waitFor(page, (x) => myPriority(x) && me(x).libraryCount === 0, { label: 'hand loaded' });
  // Put the lands back so the hand only holds the cards under test (a 40-card hand overlaps too much to click).
  for (const hid of me(s).hand) if (s.view.objects[hid]?.types.includes('Land')) await manual({ kind: 'moveObject', objectId: hid, toZone: 'library', position: 'bottom' });
  s = await waitFor(page, (x) => myPriority(x) && (me(x).hand?.length ?? 0) <= 8, { label: 'hand trimmed' });
  for (const n of ['Red Tiger Mechan', "Kolaghan's Command", 'Banefire', 'Bonecrusher Giant', 'Valakut Awakening', 'Abrade']) assert(!!inHand(s, n), `${n} is in hand`);
  await page.shot('01-loaded');

  // 1. MDFC: play the back face as a land.
  let id = inHand(s, 'Valakut Awakening');
  await clickCard(page, id);
  await page.locator('button', { hasText: /play valakut stoneforge as a land/i }).click({ timeout: 5000 });
  s = await waitFor(page, (x) => x.view.objects[id]?.zone === 'battlefield', { label: 'Stoneforge on battlefield' });
  assert(/Stoneforge/.test(s.view.objects[id].name), `MDFC back face played as a land (${s.view.objects[id].name})`);

  // 2. Warp alternative cost: the dialog must actually cast.
  id = inHand(s, 'Red Tiger Mechan');
  s = await waitFor(page, myPriority, { label: 'priority before warp' });
  console.log('alt costs offered:', JSON.stringify(s.decision.alternativeCosts), 'playable:', s.decision.playableCards.includes(id), 'pool:', JSON.stringify(me(s).manaPool ?? me(s).manaAvailable));
  assert(s.decision.alternativeCosts?.some((a) => a.objectId === id && a.id === 'warp'), 'warp offered as an alternative cost');
  await clickCard(page, id);
  await page.getByTestId('cast-alt-warp').click({ timeout: 5000 });
  s = await waitFor(page, (x) => x.view.objects[id]?.zone === 'stack' || x.view.objects[id]?.zone === 'battlefield', { label: 'warped creature cast' });
  assert(await page.getByTestId('cast-alt-warp').count() === 0, 'alternative-cost dialog closed after choosing');
  s = await resolveStack();
  assert(s.view.objects[id]?.zone === 'battlefield', 'warped creature resolved onto the battlefield');

  // 3. Alternative-cost dialog, normal cost.
  await manual({ kind: 'draw', count: 0 });
  s = await waitFor(page, myPriority, { label: 'priority' });
  const abrade = inHand(s, 'Abrade');
  await clickCard(page, abrade);
  // Abrade has no alternative cost: it goes straight to the modal choice.
  s = await waitFor(page, (x) => x.decision?.type === 'chooseOption', { label: 'Abrade mode choice' });
  const dmg = s.decision.options.find((o) => /damage/i.test(o.label));
  await page.locator('.modal button.option', { hasText: dmg.label }).click();
  // Our warped creature is the only creature around, so the engine may pick it without asking.
  s = await waitFor(page, (x) => x.decision?.type === 'chooseTargets' || x.view.stack.length > 0, { label: 'Abrade target choice' });
  if (s.decision?.type === 'chooseTargets') {
    await clickCard(page, id);
    await page.getByTestId('confirm-targets').click();
  }
  s = await resolveStack();
  assert(s.view.objects[id]?.zone !== 'battlefield', 'Abrade resolved (3 damage killed the 3-toughness creature)');

  // 4. Multi-mode spell (choose two) with a player target.
  const lifeBefore = opp(s).life;
  const kc = inHand(s, "Kolaghan's Command");
  await clickCard(page, kc);
  s = await waitFor(page, (x) => x.decision?.type === 'chooseOption' && x.decision.max === 2, { label: "Kolaghan's Command modes" });
  const wanted = s.decision.options.filter((o) => /discards|damage/i.test(o.label)).slice(0, 2);
  assert(wanted.length === 2, 'found discard + damage modes');
  for (const o of wanted) await page.locator('.modal button.option', { hasText: o.label }).click();
  await page.locator('.modal button.primary', { hasText: /confirm/i }).click();
  s = await waitFor(page, (x) => x.decision?.type === 'chooseTargets', { label: "Kolaghan's Command targets" });
  await act(page, s); // picks the opponent for each slot
  s = await resolveStack();
  assert(opp(s).life === lifeBefore - 2, `Kolaghan's Command dealt 2 to the opponent (${lifeBefore} -> ${opp(s).life})`);

  // 5. X spell: the number prompt, then a target.
  const life2 = opp(s).life;
  const bane = inHand(s, 'Banefire');
  await clickCard(page, bane);
  s = await waitFor(page, (x) => x.decision?.type === 'chooseNumber', { label: 'Banefire X prompt' });
  await page.locator('.decision-bar input[type=number], input[type=number]').first().fill('5');
  await page.locator('button.primary', { hasText: /^ok$/i }).click();
  s = await waitFor(page, (x) => x.decision?.type === 'chooseTargets', { label: 'Banefire target' });
  await act(page, s);
  s = await resolveStack();
  assert(opp(s).life === life2 - 5, `Banefire for X=5 dealt 5 (${life2} -> ${opp(s).life})`);

  // 6. Adventure: cast the creature half from the face dialog.
  const giant = inHand(s, 'Bonecrusher Giant');
  await clickCard(page, giant);
  await page.locator('button', { hasText: /^cast bonecrusher giant/i }).click({ timeout: 5000 });
  s = await waitFor(page, (x) => ['stack', 'battlefield'].includes(x.view.objects[giant]?.zone), { label: 'Giant cast' });
  s = await resolveStack();
  assert(s.view.objects[giant]?.zone === 'battlefield', 'Bonecrusher Giant resolved onto the battlefield');
  await page.shot('99-end');
  assert(page.errors.length === 0, `no page errors (${page.errors.join(' | ')})`);
  console.log('CAST OPTIONS E2E PASSED');
} catch (err) {
  await page.shot('fail').catch(() => {});
  console.error('CAST OPTIONS E2E FAILED:', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
