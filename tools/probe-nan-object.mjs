import { launch } from './bisect.mjs';
const ctx = await launch();
const page = await ctx.browser.newPage({ viewport: { width: 640, height: 360 } });
await page.goto(`${ctx.base}/?auto&warp=6`, { waitUntil: 'load' });
await page.waitForFunction('window.__rr !== undefined');
await page.waitForTimeout(1500);
const res = await page.evaluate(async () => {
  const { renderer, scene, camera, game, THREE } = window.__rr;
  const W = 320, H = 180;
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, depthBuffer: true });
  const f32 = new Float32Array(W * H * 4);
  const count = () => { let bad = 0; for (let i = 0; i < f32.length; i++) if (!Number.isFinite(f32[i])) bad++; return bad; };
  const renderCount = () => { renderer.setRenderTarget(rt); renderer.render(scene, camera); renderer.readRenderTargetPixels(rt, 0, 0, W, H, f32); return count(); };
  const label = (o) => `${o.type}${o.name ? `"${o.name}"` : ''} geo=${o.geometry?.type ?? '-'} mat=${[].concat(o.material ?? []).map((m) => m.name || m.type).join('+') || '-'} inst=${o.isInstancedMesh ? o.count : (o.geometry?.attributes?.position?.count ?? '')}`;
  const hits = [];
  for (let f = 0; f < 40 && hits.length < 3; f++) {
    await new Promise((r) => requestAnimationFrame(r));
    const full = renderCount();
    if (!full) continue;
    // Same tick, same state: isolate by rendering each drawable alone.
    const drawables = []; scene.traverse((o) => { if (o.isMesh || o.isPoints || o.isLine) drawables.push(o); });
    const vis = new Map(drawables.map((o) => [o, o.visible]));
    const per = [];
    for (const o of drawables) {
      for (const d of drawables) d.visible = d === o;
      let p = o.parent; while (p) { p.visible = true; p = p.parent; }
      const n = renderCount();
      if (n) per.push({ n, what: label(o), parentName: o.parent?.name || o.parent?.type });
    }
    for (const [o, v] of vis) o.visible = v;
    hits.push({ f, full, time: +game.time.toFixed(3), bullets: game.bullets.length, per });
  }
  renderer.setRenderTarget(null);
  return hits;
});
console.log(res.length ? JSON.stringify(res, null, 1) : 'no NaN frame in 40 frames');
await page.close(); await ctx.close();
