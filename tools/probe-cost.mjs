import { launch } from './bisect.mjs';

/** Per-pass cost decomposition: what each full-scene traversal actually submits. */
const ctx = await launch();
const variants = [
  ['full frame', ``],
  ['no water reflection pass', `rr.water.update = () => {};`],
  ['no shadow pass', `rr.renderer.shadowMap.enabled = false; rr.scene.traverse(o => { if (o.material) [].concat(o.material).forEach(m => m.needsUpdate = true); });`],
  ['no post (direct render)', `rr.post.render = () => rr.renderer.render(rr.scene, rr.camera);`],
  ['no reflection + no shadow + no post', `rr.water.update = () => {}; rr.renderer.shadowMap.enabled = false; rr.scene.traverse(o => { if (o.material) [].concat(o.material).forEach(m => m.needsUpdate = true); }); rr.post.render = () => rr.renderer.render(rr.scene, rr.camera);`],
];
for (const [name, patch] of variants) {
  const page = await ctx.browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${ctx.base}/?auto&warp=14`, { waitUntil: 'load' });
  await page.waitForFunction('window.__rr !== undefined');
  await page.waitForTimeout(1500);
  const r = await page.evaluate(async (patch) => {
    const rr = window.__rr; new Function('rr', patch)(rr);
    const s = []; for (let i = 0; i < 4; i++) { await new Promise((r) => requestAnimationFrame(r)); s.push([rr.renderer.info.render.calls, rr.renderer.info.render.triangles]); }
    const last = s.at(-1); return { calls: last[0], tris: last[1], chunks: rr.terrain.chunks.size, ents: rr.game.ents.length };
  }, patch);
  console.log(`${name.padEnd(38)} draws=${String(r.calls).padStart(4)}  tris=${String((r.tris / 1000).toFixed(0)).padStart(4)}k   (chunks ${r.chunks}, ents ${r.ents})`);
  await page.close();
}
await ctx.close();
