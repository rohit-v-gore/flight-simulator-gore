import { lerp, clamp, DEG } from './util.js';

/*
 * F-22A Raptor reference geometry in the design frame
 * (s = metres aft of the nose tip, y = metres to starboard, w = metres up; w = 0 is the wing root plane).
 * Published figures: length 18.92 m, span 13.56 m, height 5.08 m, wing area 78 m²,
 * leading-edge sweep 42°, trailing-edge sweep -17°, vertical tails canted 28°.
 */

/** Overall reference figures (metres). */
export const DIM = {
  length: 18.92,
  span: 13.56,
  height: 5.08,
  groundW: -2.3,
  centerS: 9.6,
};

/* ------------------------------- Wing ------------------------------- */

const LE_SWEEP = 42 * DEG;
const TE_SWEEP = -17 * DEG;
const Y_ROOT = 1.15; // root rib buried inside the fuselage
const Y_TIP = DIM.span / 2;
const LE_AT = { y: 1.9, s: 8.65 };
const TIP_CHORD = 1.55;
const ANHEDRAL = -3.25 * DEG;

const leS = (y) => LE_AT.s + (y - LE_AT.y) * Math.tan(LE_SWEEP);
const tipTE = leS(Y_TIP) + TIP_CHORD;
// forward-swept trailing edge: inboard stations end further aft
const teS = (y) => tipTE + (Y_TIP - y) * Math.tan(-TE_SWEEP);

export const WING = {
  yRoot: Y_ROOT,
  yTip: Y_TIP,
  leS,
  teS,
  wAt: (y) => Math.tan(ANHEDRAL) * Math.max(0, y - LE_AT.y),
  tRoot: 0.0592,
  tTip: 0.0429,
  camber: 0.004,
  // control surfaces, as span stations (y) and absolute chords (m)
  lef: { y0: 2.05, y1: 6.55, chord: 0.5 },
  flaperon: { y0: 2.05, y1: 4.15, chord: 1.0 },
  aileron: { y0: 4.25, y1: 6.25, chord: 0.62 },
};

/** Wing section frame at span station y (starboard). */
export function wingFrame(y) {
  const W = WING;
  const f = clamp((y - W.yRoot) / (W.yTip - W.yRoot), 0, 1);
  const w = W.wAt(y);
  return {
    le: [W.leS(y), y, w],
    te: [W.teS(y), y, w],
    up: [0, 0, 1],
    t: lerp(W.tRoot, W.tTip, f),
    m: W.camber,
  };
}

export const wingChord = (y) => WING.teS(y) - WING.leS(y);

/* ---------------------------- Stabilators ---------------------------- */

export const STAB = {
  root: { y: 1.5, le: 15.05, te: 18.85 },
  tip: { y: 4.45, le: 15.05 + (4.45 - 1.5) * Math.tan(LE_SWEEP), te: 18.62 },
  w: -0.05,
  pivot: [17.15, 0, -0.05],
  tRoot: 0.045,
  tTip: 0.035,
};

/* --------------------------- Vertical tails --------------------------- */

export const FIN = {
  y: 1.42,
  baseW: 0.24,
  cant: 28 * DEG,
  span: 2.78,
  root: { le: 13.35, te: 17.25 },
  tip: { le: 13.35 + 2.78 * Math.tan(22.9 * DEG), te: 15.95 },
  rudder: { h0: 0.18, h1: 1.55, chord: 0.85 },
  tRoot: 0.045,
  tTip: 0.035,
};

export function finLE(h) {
  const f = clamp(h / FIN.span, 0, 1.2);
  return [lerp(FIN.root.le, FIN.tip.le, f), lerp(FIN.root.te, FIN.tip.te, f)];
}

/** Lateral and vertical position [y, w] of the fin root line, h metres up its canted span. */
export function finBase(h) {
  const outward = Math.sin(FIN.cant);
  const upward = Math.cos(FIN.cant);
  return [FIN.y + h * outward, FIN.baseW + h * upward];
}

/* ------------------------------ Landing gear ------------------------------ */

export const GEAR = {
  nose: { s: 4.05, wheelR: 0.29, wheelW: 0.2 },
  main: { s: 11.55, y: 1.66, wheelR: 0.46, wheelW: 0.26 },
};

/* ------------------------- 2D thrust-vectoring nozzles ------------------------- */

export const NOZZLE = {
  y: 0.66, // nozzle centreline, each side
  w: -0.08,
  s0: 16.75, // nozzle box starts (inside the aft fuselage)
  sHinge: 17.55, // divergent flap hinge line
  sExit: 18.2,
  hw: 0.44, // half width at the hinge
  hh: 0.3, // half height at the hinge
  vector: 20, // max pitch vectoring, degrees
};

export { clamp };
