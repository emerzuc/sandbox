export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const invLerp = (a, b, v) => (v - a) / (b - a);

/** Move `cur` toward `target` by at most `maxDelta`. */
export function approach(cur, target, maxDelta) {
  const d = target - cur;
  if (Math.abs(d) <= maxDelta) return target;
  return cur + Math.sign(d) * maxDelta;
}

/**
 * Frame-rate independent exponential smoothing. `lambda` is the rate: higher
 * snaps faster. Unlike a raw lerp(cur, target, k) this behaves identically at
 * 60 and 144 Hz, which matters because the camera runs on frame time, not on
 * the fixed sim step.
 */
export const damp = (cur, target, lambda, dt) =>
  lerp(cur, target, 1 - Math.exp(-lambda * dt));
