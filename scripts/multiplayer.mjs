// Plays a two-player game for real: one browser hosts, another joins by code
// and steers their ship. By default they connect over the internet through
// the public matchmaking service; MODE=local uses two tabs and no network.
// Run the dev server first: npx vite --port 5183 --strictPort
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE ?? 'http://localhost:5183/';
const OUT = 'screenshots';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// MODE=local connects two tabs of one browser with no network at all (?net=local).
const LOCAL = process.env.MODE === 'local';
const launch = () =>
  puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    protocolTimeout: 30000,
    args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1440,810'],
  });
let shared = null;

async function open(name) {
  const browser = LOCAL ? (shared ??= await launch()) : await launch();
  // Each player gets a window of their own, so neither is treated as a background tab.
  const session = await browser.target().createCDPSession();
  const { targetId } = await session.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  const target = await browser.waitForTarget((t) => t._targetId === targetId);
  const page = await target.page();
  await page.setViewport({ width: 1440, height: 810 });
  page.on('pageerror', (error) => console.log(`[${name}] PAGE ERROR ${error.message}`));
  return { browser, page, leave: () => (LOCAL ? page.close() : browser.close()) };
}

const text = (page, selector) => page.$eval(selector, (element) => element.textContent.trim());
const active = (page) => page.$$eval('.screen.active', (screens) => screens.map((s) => s.id).join(','));

fs.mkdirSync(OUT, { recursive: true });
const host = await open('host');
const guest = await open('guest');
let failed = false;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed = true;
};

try {
  await host.page.goto(LOCAL ? `${BASE}?net=local` : BASE);
  await wait(800);
  await host.page.click('[data-cmd="online"]');
  await host.page.type('#online-name', 'Ana');
  await host.page.click('[data-cmd="host"]');
  await host.page.waitForSelector('#lobby.active', { timeout: 20000 });
  const code = await text(host.page, '#lobby-code');
  check('host opens a room', /^[A-Z0-9]{5}$/.test(code), code);

  await guest.page.goto(await host.page.$eval('#lobby-link', (input) => input.value));
  await wait(800);
  // In local mode the name box is already filled in with the host's.
  await guest.page.$eval('#online-name', (input) => (input.value = ''));
  await guest.page.type('#online-name', '<i>Ben</i>');
  await guest.page.click('[data-cmd="join"]');
  await guest.page.waitForSelector('#lobby.active', { timeout: 30000 });
  await guest.page.keyboard.press('ArrowRight');
  await wait(1500);
  const players = await text(host.page, '#lobby-players');
  check('both players are in the host lobby', players.includes('Ana') && players.includes('<i>Ben</i>'), players.replace(/\s+/g, ' '));
  check('the guest cannot start the race', (await guest.page.$eval('#lobby-start', (b) => b.style.display)) === 'none');
  await host.page.screenshot({ path: `${OUT}/mp-lobby-host.png` });
  await guest.page.screenshot({ path: `${OUT}/mp-lobby-guest.png` });

  await host.page.click('[data-cmd="lobby-start"]');
  await guest.page.waitForSelector('#race.active', { timeout: 10000 });
  check('the race starts for the guest', true);
  await wait(4500);
  await guest.page.keyboard.down('KeyW');
  await wait(14000);
  const guestKnots = Number(await text(guest.page, '#hud-knots'));
  check('the guest ship answers the guest helm', guestKnots > 8, `${guestKnots} knots`);
  const hostKnots = Number(await text(host.page, '#hud-knots'));
  // AI ships starting behind it can nudge it along a little.
  check('the host ship is not steered by the guest', hostKnots < guestKnots / 2, `${hostKnots} knots`);
  const hostBoard = (await text(host.page, '#hud-board')).replace(/\s+/g, ' ');
  const guestBoard = (await text(guest.page, '#hud-board')).replace(/\s+/g, ' ');
  const order = (board) => board.replace(/[+−][\d ]+m/g, '').replace(/\s+/g, ' ');
  check('both see the same running order', order(hostBoard) === order(guestBoard), `${order(hostBoard)} | ${order(guestBoard)}`);
  const time = async (page) => text(page, '#hud-race-time');
  const [a, b] = [await time(host.page), await time(guest.page)];
  const seconds = (t) => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]);
  check('race clocks agree to within half a second', Math.abs(seconds(a) - seconds(b)) < 0.5, `${a} vs ${b}`);
  await host.page.screenshot({ path: `${OUT}/mp-race-host.png` });
  await guest.page.screenshot({ path: `${OUT}/mp-race-guest.png` });

  await host.leave();
  await guest.page.waitForSelector('#online.active', { timeout: 30000 });
  check('the guest is told when the host goes', true, await text(guest.page, '#online-status'));
} catch (error) {
  check('run completes', false, `${error.message} (host on ${await active(host.page).catch(() => '?')}, guest on ${await active(guest.page).catch(() => '?')}: ${await text(guest.page, '#online-status').catch(() => '')})`);
}
await host.browser.close().catch(() => {});
await guest.browser.close().catch(() => {});
process.exit(failed ? 1 : 0);
