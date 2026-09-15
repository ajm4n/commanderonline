/** Solo / goldfish: play several full turns through the UI, casting, attacking and targeting. */
import { launch, newPage, pickSampleDeck, waitFor, act, assert, sleep, URL } from './lib.mjs';

const browser = await launch();
const page = await newPage(browser, 'solo');
try {
  await pickSampleDeck(page, 'AJ', `${URL}?seed=11&botDelay=50`);
  await page.locator('button', { hasText: /start solo/i }).first().click();
  await page.getByTestId('start-game').click({ timeout: 15000 });
  let s = await waitFor(page, (x) => !!x.decision, { label: 'first decision' });
  await page.shot('01-start');
  const actions = { cast: 0, attack: 0, targets: 0, land: 0 };
  let lastTurn = 0;
  const started = Date.now();
  while (Date.now() - started < 180000) {
    s = await waitFor(page, (x) => x.view.over || (!!x.decision && x.decision.player === x.view.you), { label: 'my decision', timeout: 60000 });
    if (s.view.over) break;
    if (s.view.turn.number >= 8) break;
    if (s.view.turn.number !== lastTurn) {
      lastTurn = s.view.turn.number;
      await page.shot(`turn-${lastTurn}`);
    }
    const before = s.decision.id;
    const what = await act(page, s);
    if (what.startsWith('cast')) actions.cast++;
    if (what.startsWith('attack with') && !what.endsWith(' 0')) actions.attack++;
    if (what === 'targets') actions.targets++;
    if (what.startsWith('play land')) actions.land++;
    console.log(`t${s.view.turn.number} ${s.view.turn.step}: ${what}`);
    await waitFor(page, (x) => x.view.over || x.decision?.id !== before || x.decision?.player !== x.view.you, { label: 'decision to advance', timeout: 30000 }).catch(() => {});
    await sleep(60);
  }
  s = await waitFor(page, () => true);
  await page.shot('99-end');
  const me = s.view.players.find((p) => p.id === s.view.you);
  const bot = s.view.players.find((p) => p.id !== s.view.you);
  console.log('final:', { turn: s.view.turn.number, myLife: me.life, botLife: bot.life, actions, battlefield: s.view.battlefield.length });
  assert(s.view.turn.number >= 6, 'played at least six turns through the UI');
  assert(actions.land >= 3, 'played lands by clicking them');
  assert(actions.cast >= 2, 'cast spells by clicking them');
  assert(actions.attack >= 1, 'declared attackers through the UI');
  assert(bot.life < 40 || me.life < 40, 'combat or spells changed a life total');
  assert(page.errors.length === 0, `no page errors (${page.errors.join(' | ').slice(0, 300)})`);
  console.log('SOLO E2E PASSED');
} catch (e) {
  await page.shot('99-error');
  console.log('SOLO E2E FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
