/** UI screenshots: the Manual menu, declared attackers, declared blockers, and a targeted stack item. */
import { launch, newPage, pickSampleDeck, waitFor, act, sleep, URL } from './lib.mjs';
const browser = await launch();
const page = await newPage(browser, 'ui');
try {
  await pickSampleDeck(page, 'AJ', `${URL}?seed=11&botDelay=50`);
  await page.locator('button', { hasText: /start solo/i }).first().click();
  await page.getByTestId('start-game').click({ timeout: 15000 });
  await waitFor(page, (x) => !!x.decision, { label: 'first decision' });
  await page.getByTestId('manual-menu').click();
  await sleep(250);
  await page.shot('manual-menu');
  await page.keyboard.press('Escape');
  const got = { attackers: false, blockers: false, stack: false };
  let s;
  const t0 = Date.now();
  while (Date.now() - t0 < 170000) {
    s = await waitFor(page, (x) => x.view.over || (!!x.decision && x.decision.player === x.view.you), { timeout: 60000 });
    if (s.view.over || s.view.turn.number >= 12) break;
    const d = s.decision;
    if (!got.stack && s.view.stack.some((it) => it.targets.length)) { await page.shot('stack-targets'); got.stack = true; }
    if (!got.attackers && d.type === 'declareAttackers' && d.candidates.length) {
      await page.getByTestId('attack-all').click(); await sleep(250); await page.shot('declare-attackers'); got.attackers = true;
      await page.getByTestId('confirm-attackers').click();
      await waitFor(page, (x) => x.decision?.id !== d.id, { timeout: 30000 }).catch(() => {});
      // right after: the attackers are in combat — shoot the board once the bot gets to act
      await sleep(400); await page.shot('attacking-board');
      continue;
    }
    if (!got.blockers && d.type === 'declareBlockers' && d.candidates.length && d.attackers.length) {
      const c = d.candidates.find((x) => x.canBlock.length);
      if (c) {
        await page.locator(`[data-id="${c.id}"]`).first().click(); await sleep(150);
        await page.locator(`[data-id="${c.canBlock[0]}"]`).first().click(); await sleep(250);
        await page.shot('declare-blockers'); got.blockers = true;
        await page.getByTestId('confirm-blockers').click();
        await waitFor(page, (x) => x.decision?.id !== d.id, { timeout: 30000 }).catch(() => {});
        continue;
      }
    }
    const before = d.id;
    await act(page, s);
    await waitFor(page, (x) => x.view.over || x.decision?.id !== before || x.decision?.player !== x.view.you, { timeout: 30000 }).catch(() => {});
  }
  console.log('UI SHOTS DONE', JSON.stringify(got));
} catch (e) { await page.shot('error'); console.log('UI SHOTS FAILED', e.message.split('\n')[0]); } finally { await browser.close(); }
