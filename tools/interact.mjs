import { chromium } from 'playwright';
import { preview } from 'vite';

/**
 * Interaction gate. `npm run shots` always flies with ?auto, so it never
 * touches the paths a person actually uses: the title card, pause, mute, a
 * thumb on the glass, the game-over restart. This drives those with real key
 * and touch events and asserts on the game's own state.
 *
 * Runs at a small viewport because SwiftShader is slow and none of this is
 * about pixels. The slowness is put to use: it is what trips the adaptive
 * resolution scaler, so that path gets exercised too.
 */
const server = await preview({ preview: { port: 4174, host: '127.0.0.1' }, logLevel: 'error' });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const ctx = await browser.newContext({ viewport: { width: 480, height: 270 }, hasTouch: true });
const page = await ctx.newPage();

const faults = [];
page.on('pageerror', (e) => faults.push(`pageerror: ${e}`));
page.on('console', (m) => {
  const t = m.text();
  if (/favicon/i.test(t)) return;
  if (m.type() === 'error' || /GL_INVALID|WebGL: INVALID|Shader Error/.test(t)) faults.push(t.slice(0, 140));
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const rr = (expr) => page.evaluate(`(() => { const rr = window.__rr, g = rr.game; return ${expr}; })()`);
const until = (expr, timeout = 30000) =>
  page.waitForFunction(`(() => { const rr = window.__rr, g = rr.game; return ${expr}; })()`, null, { timeout }).then(() => true, () => false);
const card = () => page.evaluate(() => {
  const c = document.getElementById('center');
  return c.classList.contains('hidden') ? '' : document.getElementById('c-title').textContent;
});

await page.goto('http://127.0.0.1:4174/', { waitUntil: 'load' });
await page.waitForFunction('window.__rr !== undefined', null, { timeout: 30000 });
await page.waitForTimeout(2500);

// --- title card: nothing moves until the player says so ---------------------
check('starts on the title card', (await rr('rr.mode')) === 'ready' && (await card()) === 'River Raid 3D');
check('sim is frozen on the title card', (await rr('g.time')) === 0 && (await rr('g.player.pos.z')) === 0);

await page.keyboard.press('KeyM');
await page.waitForTimeout(600);
check('M mutes without starting the game', (await rr('rr.audio.muted')) === true && (await rr('rr.mode')) === 'ready');
await page.keyboard.press('KeyM');

await page.keyboard.down('KeyD');
check('first key starts the game', await until(`rr.mode === 'run' && g.time > 0.3`));
check('D steers screen-right (world -X)', await until('g.player.vx < -5'), `vx=${(await rr('g.player.vx')).toFixed(1)}`);
await page.keyboard.down('KeyX');
check('X fires the angled shot, toward the side being steered', await until('g.bullets.some((b) => b.angled && b.vx < -60)'));
await page.keyboard.up('KeyX');
await page.keyboard.up('KeyD');
await page.keyboard.down('KeyZ');
check('Z fires straight', await until('g.bullets.some((b) => !b.angled && b.vx === 0)'));
await page.keyboard.up('KeyZ');
check('title card is gone in play', (await card()) === '');

// --- pause ------------------------------------------------------------------
await page.keyboard.press('KeyP');
check('P pauses', await until(`rr.mode === 'paused'`));
const t0 = await rr('g.time');
await page.waitForTimeout(1500);
check('sim is frozen while paused', (await rr('g.time')) === t0 && (await card()) === 'Pausado');
await page.keyboard.press('KeyM');
await page.waitForTimeout(600);
check('M while paused does not resume', (await rr('rr.mode')) === 'paused');
await page.keyboard.press('KeyM');
await page.keyboard.press('KeyP');
check('P resumes', await until(`rr.mode === 'run' && g.time > ${t0}`));

await page.evaluate(() => window.dispatchEvent(new Event('blur')));
check('losing focus pauses', await until(`rr.mode === 'paused'`));

// --- touch: tap resumes, drag steers, touching fires ------------------------
const cdp = await ctx.newCDPSession(page);
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
});
await rr('(g.player.invuln = 1e9, g.player.vx = 0, 0)'); // hold still for the assertions
await touch('touchStart', 200, 180);
check('a tap resumes from pause', await until(`rr.mode === 'run'`));
await touch('touchMove', 150, 180);
check('dragging left steers screen-left (world +X)', await until('g.player.vx > 5'), `vx=${(await rr('g.player.vx')).toFixed(1)}`);
check('touching fires', await until('g.bullets.length > 0'));
const stick = await page.evaluate(() => document.getElementById('stick').style.opacity);
check('floating stick is drawn under the thumb', stick === '1');
await touch('touchMove', 150, 100);
check('pushing up opens the throttle', await until('g.player.speed > 100'), `speed=${(await rr('g.player.speed')).toFixed(0)}`);
await touch('touchEnd', 0, 0);
check('lifting the thumb centres the stick', await until('Math.abs(g.player.vx) < 1'));

// --- game over: lockout, then restart ---------------------------------------
await rr(`(g.player.invuln = 0, g.lives = 1, g.die('test'), 0)`);
check('last plane ends the game', await until(`g.state === 'gameover'`));
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
check('a restart press inside the lockout is ignored', (await rr('g.state')) === 'gameover');
check('game-over card is up', /Fim de jogo|Novo recorde/.test(await card()));
await until('g.overT > 1.0');
await page.keyboard.press('Enter');
check('restart works after the lockout', await until(`g.state === 'playing' && g.lives === 3`));

// --- adaptive resolution ----------------------------------------------------
check('slow frames shed resolution', await until('rr.quality < 1', 20000), `quality=${(await rr('rr.quality')).toFixed(2)}`);
await page.waitForTimeout(1500);
check('no console or GL faults', faults.length === 0, [...new Set(faults)].slice(0, 2).join(' | '));

await browser.close();
await server.close();
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} FAILED` : `\nall ${results.length} interaction checks passed`);
process.exit(failed.length ? 1 : 0);
