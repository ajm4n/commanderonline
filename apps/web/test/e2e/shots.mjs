/** Screenshot the main screens at desktop and phone sizes (for layout work, not a test). */
import { launch, waitFor, sleep, URL, SHOTS } from './lib.mjs';

const browser = await launch();
const sizes = [
  { name: 'desktop', width: 1500, height: 900 },
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'phone-land', width: 844, height: 390, mobile: true },
];
for (const s of sizes) {
  const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height }, isMobile: !!s.mobile, hasTouch: !!s.mobile, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${s.name}-${n}.png` });
  try {
    await page.goto(`${URL}?seed=11&botDelay=50`, { waitUntil: 'networkidle' });
    await page.getByPlaceholder('Planeswalker').fill('AJ');
    await shot('1-home');
    await page.locator('button', { hasText: /pick a deck|deck/i }).first().click();
    await sleep(300);
    await shot('2-deckpicker');
    await page.locator('button', { hasText: /sample/i }).first().click();
    await page.locator('button', { hasText: /^load deck/i }).first().click();
    await page.waitForFunction(() => /use this deck/i.test(document.body.innerText), null, { timeout: 120000 });
    await shot('2b-deckloaded');
    await page.locator('button', { hasText: /^use this deck/i }).first().click();
    await sleep(300);
    await page.locator('button', { hasText: /start solo/i }).first().click();
    await sleep(300);
    await shot('2c-lobby');
    await page.getByTestId('start-game').click({ timeout: 15000 });
    await waitFor(page, (x) => !!x.decision, { label: 'first decision' });
    await sleep(400);
    await shot('3-mulligan');
    await page.getByTestId('keep').click();
    await waitFor(page, (x) => x.decision?.type === 'priority', { label: 'priority', timeout: 60000 });
    await sleep(600);
    await shot('4-game');
    console.log(`${s.name}: ok`);
  } catch (e) {
    await shot('9-error');
    console.log(`${s.name}: FAILED ${e.message.split('\n')[0]}`);
  } finally {
    await ctx.close();
  }
}
await browser.close();
