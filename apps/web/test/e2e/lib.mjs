/** Shared helpers for the browser end-to-end scripts. */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

export const URL = process.env.E2E_URL ?? 'http://localhost:8790/';
export const SHOTS = process.env.E2E_SHOTS ?? '/tmp/claude-0/-home-user-talks/17275228-bb92-5666-9e64-06d7ffeb05a0/scratchpad/e2e-shots';
mkdirSync(SHOTS, { recursive: true });

export async function launch() {
  const executablePath = process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
  const proxy = process.env.HTTPS_PROXY;
  return chromium.launch({ executablePath, args: ['--no-sandbox', ...(proxy ? [`--proxy-server=${proxy}`, '--proxy-bypass-list=localhost;127.0.0.1'] : [])] });
}

export async function newPage(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/ERR_TOO_MANY_RETRIES|Failed to load resource|429/.test(m.text())) page.errors.push(m.text());
  });
  page.shot = (n) => page.screenshot({ path: `${SHOTS}/${name}-${n}.png` });
  return page;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
  console.log('  ok:', msg);
}

/** Current view + decision from the client's debug hook. */
export async function state(page) {
  return page.evaluate(() => {
    const c = window.__co;
    return c ? { view: c.view, decision: c.decision } : null;
  });
}

export async function waitFor(page, pred, { timeout = 30000, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const s = await state(page);
    if (s && pred(s)) return s;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${label}; last decision: ${JSON.stringify(s?.decision)?.slice(0, 300)}; step ${s?.view?.turn?.step} turn ${s?.view?.turn?.number}`);
    await sleep(150);
  }
}

/** Home → deck picker → sample deck → back home with a deck set. */
export async function pickSampleDeck(page, name, url = URL) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByPlaceholder('Planeswalker').fill(name);
  await page.locator('button', { hasText: /pick a deck|deck/i }).first().click();
  await page.locator('button', { hasText: /sample/i }).first().click();
  await page.locator('button', { hasText: /^load deck/i }).first().click();
  await page.waitForFunction(() => /use this deck/i.test(document.body.innerText), null, { timeout: 120000 });
  await page.locator('button', { hasText: /^use this deck/i }).first().click();
  await page.waitForTimeout(300);
}

export async function clickCard(page, id) {
  await page.locator(`[data-id="${id}"]`).first().click({ timeout: 5000 });
}

/**
 * Take one sensible action for the current decision using the DOM.
 * Returns a short description of what was done.
 */
export async function act(page, s) {
  const { view, decision: d } = s;
  const me = view.players.find((p) => p.id === view.you);
  switch (d.type) {
    case 'mulligan':
      await page.getByTestId('keep').click();
      return 'keep';
    case 'priority': {
      // Land first, then the most expensive castable spell, otherwise pass.
      const landId = d.playableCards.find((id) => view.objects[id]?.types.includes('Land') && me.hand?.includes(id));
      if (landId && d.canPlayLand) {
        await clickCard(page, landId);
        return `play land ${view.objects[landId].name}`;
      }
      const spells = d.playableCards.filter((id) => !view.objects[id]?.types.includes('Land')).sort((a, b) => (view.objects[b]?.manaValue ?? 0) - (view.objects[a]?.manaValue ?? 0));
      if (spells.length && view.stack.length === 0) {
        const id = spells[0];
        const o = view.objects[id];
        if (o.zone === 'hand' || o.zone === 'command') {
          await clickCard(page, id);
          // Alternative-cost dialog: prefer the normal cost.
          const normal = page.getByTestId('cast-normal');
          if (await normal.count()) await normal.click();
          return `cast ${o.name}`;
        }
      }
      await page.getByTestId('pass').click();
      return 'pass';
    }
    case 'chooseTargets': {
      for (let i = 0; i < d.slots.length; i++) {
        const slot = d.slots[i];
        const pick = slot.legal.find((t) => t.kind === 'player' && t.id !== view.you) ?? slot.legal.find((t) => t.kind === 'object' && view.objects[t.id]?.controller !== view.you) ?? slot.legal[0];
        if (!pick) continue;
        if (pick.kind === 'player') await page.locator(`[data-player="${pick.id}"]`).first().click();
        else if (pick.kind === 'object') await clickCard(page, pick.id);
        else await page.locator('.stack-item, [data-stack-id]').first().click().catch(() => {});
        await sleep(100);
      }
      await page.getByTestId('confirm-targets').click();
      return 'targets';
    }
    case 'declareAttackers':
      if (d.candidates.length) await page.getByTestId('attack-all').click();
      await page.getByTestId('confirm-attackers').click();
      return `attack with ${d.candidates.length}`;
    case 'declareBlockers':
      await page.getByTestId('confirm-blockers').click();
      return 'no blocks';
    case 'yesNo':
      await page.getByTestId('yes').click();
      return 'yes';
    case 'chooseObjects': {
      // Click candidates until min satisfied, then confirm.
      const n = Math.max(d.min, Math.min(1, d.max));
      for (const id of d.candidates.slice(0, n)) await clickCard(page, id).catch(() => {});
      const btn = page.locator('button.primary', { hasText: /confirm|done|ok/i }).first();
      if (await btn.count()) await btn.click();
      else await page.locator('button', { hasText: /^none$/i }).first().click();
      return `choose ${n} objects`;
    }
    case 'chooseOption': {
      const btns = page.locator('.decision-bar button, .modal button').filter({ hasNotText: /cancel/i });
      await btns.first().click();
      const confirm = page.locator('button.primary', { hasText: /confirm/i }).first();
      if (await confirm.count()) await confirm.click();
      return 'option';
    }
    case 'manualTrigger':
      await page.locator('button.primary', { hasText: /done/i }).first().click();
      return 'manual done';
    case 'chooseNumber':
    case 'orderObjects':
    case 'distribute':
    case 'payMana': {
      const btn = page.locator('button.primary').first();
      await btn.click();
      return d.type;
    }
  }
  return 'noop';
}
