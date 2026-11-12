// Drives the game in headless Chrome and saves screenshots, for checking visuals.
// Usage: node scripts/shots.mjs [name ...]   (needs `npm run dev` on port 5183)
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.GAME_URL ?? 'http://localhost:5183/';
const OUT = 'screenshots';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const shots = {
  title: async (page) => {
    await page.goto(BASE);
    await wait(7000);
  },
  ...Object.fromEntries(
    ['icon', 'oasis', 'quantum', 'freedom', 'radiance'].map((id, i) => [
      `ship-${id}`,
      async (page) => {
        await page.goto(BASE);
        await wait(800);
        await page.keyboard.press('Enter');
        // The menu opens on the third ship; step round to the one wanted.
        const steps = (i - 2 + 5) % 5;
        for (let k = 0; k < steps; k++) await page.keyboard.press('ArrowRight');
        await wait(Number(process.env.ORBIT ?? 9000));
      },
    ]),
  ),
  tracks: async (page) => {
    await page.goto(BASE);
    await wait(800);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowRight');
    await wait(5000);
  },
  'race-island': async (page) => {
    await page.goto(`${BASE}?demo=miami-cococay&ship=icon&t=3`);
    await wait(6000);
  },
  'race-harbour': async (page) => {
    await page.goto(`${BASE}?demo=canaveral-nassau&ship=radiance&t=40`);
    await wait(6000);
  },
  'race-fjord': async (page) => {
    await page.goto(`${BASE}?demo=seattle-juneau&ship=oasis&t=45`);
    await wait(6000);
  },
  bridge: async (page) => {
    await page.goto(`${BASE}?demo=miami-cococay&ship=quantum&t=30&cam=bridge`);
    await wait(5000);
  },
  drive: async (page) => {
    await page.goto(BASE);
    await wait(800);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await wait(4500);
    await page.keyboard.down('KeyW');
    await wait(9000);
    await page.keyboard.down('KeyD');
    await wait(5000);
  },
  results: async (page) => {
    await page.goto(`${BASE}?demo=miami-cococay&ship=radiance&t=420`);
    await wait(9000);
  },
  paused: async (page) => {
    await page.goto(`${BASE}?demo=miami-cococay&ship=freedom&t=10`);
    await wait(2500);
    await page.keyboard.press('Escape');
    await wait(500);
  },
};

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1440,810'],
});
fs.mkdirSync(OUT, { recursive: true });
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(shots);
for (const name of names) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 810 });
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warn') console.log(`[${name}] ${message.text()}`);
  });
  page.on('pageerror', (error) => console.log(`[${name}] PAGE ERROR ${error.message}`));
  if (name.startsWith('hazard:')) {
    // hazard:<route>:<n>[:<gap metres>[:<ship>[:<camera>]]] races up to the nth hazard on a route.
    // A seventh part is added to the address as it is, e.g. hold&cycle=0.2
    const [, route, n, gap = '500', ship = 'quantum', cam = 'chase', extra = ''] = name.split(':');
    await page.goto(`${BASE}?demo=${route}&ship=${ship}&near=${n}&gap=${gap}&cam=${cam}&solo&${extra}`);
    await wait(3500);
  } else if (name.startsWith('inspect:')) {
    // inspect:<class>:<angle>:<dist>:<height>[:track]
    const [, ship, angle = '0.7', dist = '0.9', h = '0.2', track = 'miami-cococay'] = name.split(':');
    await page.goto(`${BASE}?inspect=${ship}&angle=${angle}&dist=${dist}&h=${h}&track=${track}`);
    await wait(2500);
  } else {
    await shots[name](page);
  }
  const fps = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let frames = 0;
        const start = performance.now();
        const tick = () => {
          frames++;
          if (performance.now() - start < 1000) requestAnimationFrame(tick);
          else resolve(frames);
        };
        requestAnimationFrame(tick);
      }),
  );
  await page.screenshot({ path: `${OUT}/${name.replaceAll(':', '_')}.png` });
  console.log(`${name}: ${fps} fps`);
  await page.close();
}
await browser.close();
