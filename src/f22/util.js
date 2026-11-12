/* Small numeric helpers shared by the airframe modules. */

export const DEG = Math.PI / 180;

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Signed power: keeps the sign of v. */
export function spow(v, p) {
  return Math.sign(v) * Math.abs(v) ** p;
}

/** Smoothstep of x between edges a and b. */
export function sstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** n evenly spaced values from a to b inclusive. */
export function linspace(a, b, n) {
  if (n <= 1) return [a];
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}

/** n values in [0, 1], clustered towards both ends (good for airfoil chords). */
export function cosspace(n) {
  return Array.from({ length: n }, (_, i) => (1 - Math.cos((Math.PI * i) / (n - 1))) / 2);
}

/** Move `value` towards `target` by at most rate*dt. */
export function approach(value, target, rate, dt) {
  const step = rate * dt;
  const diff = target - value;
  return Math.abs(diff) <= step ? target : value + Math.sign(diff) * step;
}

/**
 * Smooth interpolating function through control points [[x, y], ...] (x ascending).
 * Piecewise cubic Hermite with Steffen's slopes: never overshoots between points.
 */
export function curve(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const n = xs.length;
  if (n === 1) return () => ys[0];
  const h = [];
  const d = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    d.push((ys[i + 1] - ys[i]) / h[i]);
  }
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    const p = (d[i - 1] * h[i] + d[i] * h[i - 1]) / (h[i - 1] + h[i]);
    m[i] = (Math.sign(d[i - 1]) + Math.sign(d[i])) * Math.min(Math.abs(d[i - 1]), Math.abs(d[i]), 0.5 * Math.abs(p));
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      ys[i] * (2 * t3 - 3 * t2 + 1) + m[i] * h[i] * (t3 - 2 * t2 + t) + ys[i + 1] * (3 * t2 - 2 * t3) + m[i + 1] * h[i] * (t3 - t2)
    );
  };
}
