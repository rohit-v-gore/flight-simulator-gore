import { WING, STAB, FIN, finLE, finBase } from './dims.js';
import { MAIN_BAY, SIDE_BAY } from './bays.js';
import { intakeSection, INTAKE } from './body.js';
import { CANOPY } from './cockpit.js';
import { lerp } from './util.js';

/*
 * Procedural F-22 paint, drawn on one canvas atlas with four orthographic views of the airframe:
 * top, bottom, starboard side and port side. The livery shader (materials.js) projects whichever views
 * face a surface onto it, so the same atlas works for every part without UV unwrapping.
 */

/** Design-frame box covered by the projections (metres). */
export const RANGE = { s0: -0.3, S: 19.8, y0: -7.0, Y: 14.0, w0: -2.4, W: 5.6 };

/** Atlas layout in pixels: plan views in the top half, side views below. */
export const ATLAS = {
  w: 2048,
  h: 4096,
  top: { x: 0, y: 0, w: 1024, h: 2048 },
  bottom: { x: 1024, y: 0, w: 1024, h: 2048 },
  stbd: { x: 0, y: 2048, w: 2048, h: 1024 },
  port: { x: 0, y: 3072, w: 2048, h: 1024 },
};

export const SCHEMES = {
  raptor: {
    name: 'Have Glass two-tone grey',
    base: '#80878d',
    lower: '#80878d',
    patch: '#646b71',
    patch2: '#717880',
    edge: '#5a6066',
    mark: '#565c62',
    markLight: '#9aa1a7',
    weather: 0.8,
  },
  ghost: {
    name: 'Ghost grey (test fleet)',
    base: '#9aa0a5',
    lower: '#a7adb2',
    patch: null,
    patch2: null,
    edge: '#7e858b',
    mark: '#6c7378',
    markLight: '#c3c8cc',
    weather: 0.45,
  },
};

/* ------------------------------ drawing kit ------------------------------ */

/** Deterministic pseudo-random sequence (xorshift32). */
function random(seed) {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

/**
 * A drawing view onto one atlas region. Design points are given as (a, b):
 * plan views use (s, y), side views use (s, w). `P` returns canvas pixels; `ka`/`kb` are px per metre.
 */
function view(ctx, region, kind) {
  const R = RANGE;
  const r = ATLAS[region];
  if (kind === 'plan') {
    const ka = r.h / R.S;
    const kb = r.w / R.Y;
    const flip = region === 'bottom'; // seen from below, starboard is on the left
    return {
      ctx, r, ka, kb,
      P: (s, y) => [r.x + (flip ? R.y0 + R.Y - y : y - R.y0) * kb, r.y + (s - R.s0) * ka],
    };
  }
  const ka = r.w / R.S;
  const kb = r.h / R.W;
  const fromRight = region === 'stbd'; // seen from starboard, the nose points right
  return {
    ctx, r, ka, kb,
    P: (s, w) => [r.x + (fromRight ? R.s0 + R.S - s : s - R.s0) * ka, r.y + (R.w0 + R.W - w) * kb],
  };
}

function path(V, pts) {
  const { ctx } = V;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [x, y] = V.P(p[0], p[1]);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
}

function fillPoly(V, pts, color) {
  path(V, pts);
  V.ctx.closePath();
  V.ctx.fillStyle = color;
  V.ctx.fill();
}

function strokePoly(V, pts, color, width, close = true) {
  path(V, pts);
  if (close) V.ctx.closePath();
  V.ctx.strokeStyle = color;
  V.ctx.lineWidth = width;
  V.ctx.stroke();
}

/**
 * Run `draw` in a local frame centred on design point (a, b) with 1 unit = 1 metre, x to the viewer's
 * right and y down the canvas. Handles the views' unequal horizontal and vertical scales.
 */
function inMetres(V, a, b, draw) {
  const { ctx } = V;
  const [cx, cy] = V.P(a, b);
  const plan = V.r.h > V.r.w;
  const sx = plan ? V.kb : V.ka;
  const sy = plan ? V.ka : V.kb;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(sx, sy);
  draw(ctx);
  ctx.restore();
}

function label(V, a, b, str, height, color, weight = 700) {
  inMetres(V, a, b, (ctx) => {
    ctx.font = `${weight} 100px "Arial Narrow", "Roboto Condensed", Arial, sans-serif`;
    ctx.scale(height / 72, height / 72);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(str, 0, 0);
  });
}

/** Low-visibility national insignia: outlined roundel with a five-point star and side bars. */
function insignia(V, a, b, radius, color) {
  inMetres(V, a, b, (ctx) => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = radius * 0.06;
    const barW = radius * 1.05;
    const barH = radius * 0.46;
    for (const dir of [-1, 1]) {
      ctx.strokeRect(dir > 0 ? radius * 0.92 : -radius * 0.92 - barW, -barH * 0.35, barW, barH);
    }
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i <= 10; i++) {
      const rr = i % 2 ? radius * 0.37 : radius * 0.93;
      const ang = -Math.PI / 2 + (i * Math.PI) / 5;
      ctx.lineTo(rr * Math.cos(ang), rr * Math.sin(ang));
    }
    ctx.globalAlpha = 0.3;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.stroke();
  });
}

/** Irregular soft-edged patch for the disruptive camouflage. */
function camoPatch(V, rnd, a, b, ra, rb, color) {
  const pts = [];
  const tilt = rnd() * Math.PI;
  for (let i = 0; i < 10; i++) {
    const t = (i / 10) * Math.PI * 2;
    const k = 0.6 + 0.55 * rnd();
    const x = Math.cos(t) * ra * k;
    const y = Math.sin(t) * rb * k;
    pts.push([a + x * Math.cos(tilt) - y * Math.sin(tilt), b + x * Math.sin(tilt) + y * Math.cos(tilt)]);
  }
  V.ctx.save();
  V.ctx.filter = 'blur(7px)';
  fillPoly(V, pts, color);
  V.ctx.restore();
}

/** Faint light/dark mottling so the paint doesn't look like plastic. */
function weathering(V, rnd, count, amount) {
  const { ctx, r } = V;
  for (let i = 0; i < count; i++) {
    const x = r.x + rnd() * r.w;
    const y = r.y + rnd() * r.h;
    const rad = 8 + rnd() * 40;
    const shade = rnd() < 0.5 ? '255,255,255' : '0,0,0';
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(${shade},${0.04 * amount})`);
    g.addColorStop(1, `rgba(${shade},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
}

/** Door outline with sawtooth fore and aft edges (the F-22's planform-aligned panel edges). */
function sawDoorOutline(V, a0, a1, b0, b1, teeth, color, width) {
  const step = (b1 - b0) / teeth;
  const depth = Math.min(0.14, (a1 - a0) * 0.1);
  const pts = [[a0, b0]];
  for (let k = 0; k < teeth; k++) pts.push([a0 - depth, b0 + (k + 0.5) * step], [a0, b0 + (k + 1) * step]);
  for (let k = teeth; k > 0; k--) pts.push([a1 - depth, b0 + (k - 0.5) * step], [a1, b0 + (k - 1) * step]);
  strokePoly(V, pts, color, width);
}

/* -------------------------------- views -------------------------------- */

function paintPlanView(ctx, region, sc) {
  const V = view(ctx, region, 'plan');
  const lower = region === 'bottom';
  const rnd = random(lower ? 4021 : 1777);
  ctx.save();
  ctx.beginPath();
  ctx.rect(V.r.x, V.r.y, V.r.w, V.r.h);
  ctx.clip();
  ctx.fillStyle = lower ? sc.lower : sc.base;
  ctx.fillRect(V.r.x, V.r.y, V.r.w, V.r.h);
  if (sc.patch) {
    for (let i = 0; i < 26; i++) {
      camoPatch(V, rnd, lerp(1.5, 18.5, rnd()), lerp(-6.4, 6.4, rnd()), lerp(0.9, 2.2, rnd()), lerp(0.45, 1.3, rnd()), i % 3 ? sc.patch : sc.patch2);
    }
  }
  weathering(V, rnd, 700, sc.weather);
  const seam = 'rgba(38,42,46,0.38)';
  for (const sg of [-1, 1]) {
    // radar-absorbent leading-edge treatment on the wing and stabilator
    const yA = WING.yRoot + 0.7;
    fillPoly(V, [[WING.leS(yA) - 0.02, sg * yA], [WING.leS(WING.yTip) - 0.02, sg * WING.yTip], [WING.leS(WING.yTip) + 0.3, sg * WING.yTip], [WING.leS(yA) + 0.3, sg * yA]], sc.edge);
    const stabLE = (y) => lerp(STAB.root.le, STAB.tip.le, (y - STAB.root.y) / (STAB.tip.y - STAB.root.y));
    const y0 = STAB.root.y + 0.1;
    fillPoly(V, [[stabLE(y0) - 0.02, sg * y0], [stabLE(STAB.tip.y) - 0.02, sg * STAB.tip.y], [stabLE(STAB.tip.y) + 0.2, sg * STAB.tip.y], [stabLE(y0) + 0.2, sg * y0]], sc.edge);
    // control-surface hinge lines and ends
    const hingeLine = (rng, sAt) => strokePoly(V, [[sAt(rng.y0), sg * rng.y0], [sAt(rng.y1), sg * rng.y1]], seam, 2, false);
    hingeLine(WING.lef, (y) => WING.leS(y) + WING.lef.chord);
    hingeLine(WING.flaperon, (y) => WING.teS(y) - WING.flaperon.chord);
    hingeLine(WING.aileron, (y) => WING.teS(y) - WING.aileron.chord);
    for (const y of [WING.flaperon.y1, WING.aileron.y0, WING.aileron.y1]) strokePoly(V, [[WING.teS(y) - 1, sg * y], [WING.teS(y), sg * y]], seam, 1.5, false);
    for (const y of [WING.lef.y0, WING.lef.y1]) strokePoly(V, [[WING.leS(y), sg * y], [WING.leS(y) + WING.lef.chord, sg * y]], seam, 1.5, false);
  }
  if (lower) {
    for (const sg of [-1, 1]) {
      sawDoorOutline(V, MAIN_BAY.s0, MAIN_BAY.s1, sg > 0 ? 0 : -MAIN_BAY.hw, sg > 0 ? MAIN_BAY.hw : 0, 3, 'rgba(32,35,40,0.55)', 3);
      sawDoorOutline(V, 10.65, 12.2, sg > 0 ? 1.02 : -1.78, sg > 0 ? 1.78 : -1.02, 2, 'rgba(32,35,40,0.55)', 3);
    }
    sawDoorOutline(V, 3.3, 4.45, -0.2, 0.2, 1, 'rgba(32,35,40,0.55)', 3);
    insignia(V, WING.leS(4.7) + 1.2, 4.7, 0.36, sc.mark);
  } else {
    insignia(V, WING.leS(4.7) + 1.2, -4.7, 0.36, sc.mark);
    strokePoly(V, [[9.6, -0.18], [10.6, -0.18], [10.6, 0.18], [9.6, 0.18]], 'rgba(32,35,40,0.4)', 2);
    strokePoly(V, [[12.6, -0.3], [13.5, -0.3], [13.5, 0.3], [12.6, 0.3]], 'rgba(32,35,40,0.4)', 2);
  }
  ctx.restore();
}

function paintSideView(ctx, region, sc, marks) {
  const V = view(ctx, region, 'side');
  const rnd = random(region === 'stbd' ? 911 : 6151);
  ctx.save();
  ctx.beginPath();
  ctx.rect(V.r.x, V.r.y, V.r.w, V.r.h);
  ctx.clip();
  ctx.fillStyle = sc.base;
  ctx.fillRect(V.r.x, V.r.y, V.r.w, V.r.h);
  if (sc.patch) {
    for (let i = 0; i < 18; i++) {
      camoPatch(V, rnd, lerp(1.0, 18.5, rnd()), lerp(-1.2, 2.6, rnd()), lerp(0.8, 1.9, rnd()), lerp(0.35, 0.8, rnd()), i % 3 ? sc.patch : sc.patch2);
    }
  }
  weathering(V, rnd, 500, sc.weather);
  const seam = 'rgba(32,35,40,0.45)';
  sawDoorOutline(V, SIDE_BAY.s0, SIDE_BAY.s1, SIDE_BAY.wBot, SIDE_BAY.wTop, 2, seam, 3);
  // intake lip edge treatment
  const sec = intakeSection(INTAKE.sMouth);
  strokePoly(V, [[INTAKE.sMouth - 0.02, sec.wti], [INTAKE.sMouth + INTAKE.lean + INTAKE.rake, sec.wbo]], sc.edge, 14, false);
  // vertical tail: leading-edge band, tail band, codes
  const finAt = (h, x) => {
    const [le, te] = finLE(h);
    return [lerp(le, te, x), finBase(h)[1]];
  };
  fillPoly(V, [finAt(0.2, 0), finAt(FIN.span, 0), finAt(FIN.span, 0.12), finAt(0.2, 0.08)], sc.edge);
  fillPoly(V, [finAt(2.25, 0.04), finAt(2.55, 0.04), finAt(2.55, 1), finAt(2.25, 1)], sc.mark);
  label(V, ...finAt(1.45, 0.5), marks.tailCode, 0.62, sc.mark);
  label(V, ...finAt(0.82, 0.48), marks.serial, 0.17, sc.mark, 600);
  label(V, ...finAt(0.58, 0.52), marks.wing, 0.13, sc.mark, 600);
  insignia(V, 9.35, -0.22, 0.24, sc.mark);
  label(V, 7.6, 0.18, 'RESCUE', 0.06, sc.markLight, 600);
  label(V, 3.2, -0.05, 'USAF', 0.14, sc.mark, 600);
  strokePoly(V, [[CANOPY.sFront, 0.12], [CANOPY.sEnd, 0.32]], 'rgba(32,35,40,0.25)', 2, false);
  ctx.restore();
}

/** Paint the whole atlas. Returns { canvas, scheme }. */
export function paintLivery(schemeKey, opts = {}) {
  const sc = SCHEMES[schemeKey] || SCHEMES.raptor;
  const marks = { tailCode: opts.tailCode || 'FF', serial: opts.serial || 'AF 09-4191', wing: opts.wing || '1 FW' };
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS.w;
  canvas.height = ATLAS.h;
  const ctx = canvas.getContext('2d');
  paintPlanView(ctx, 'top', sc);
  paintPlanView(ctx, 'bottom', sc);
  paintSideView(ctx, 'stbd', sc, marks);
  paintSideView(ctx, 'port', sc, marks);
  return { canvas, scheme: sc };
}
