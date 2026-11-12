import { curve, linspace, lerp, clamp, sstep } from './util.js';
import { loft, mirrorY } from './geom.js';

/*
 * Fuselage: a chined, faceted-looking body. Each station is two superellipse halves that meet at a sharp
 * chine line (the edge that runs from the nose tip, along the intakes, into the wing leading edge).
 *   a  - chine half-width          wc - chine height
 *   t  - height of the top above the chine,  b - depth of the bottom below it
 *   nT, nB - superellipse exponents (2 = elliptical, larger = boxier)
 */
const aC = curve([
  [0, 0.004], [0.3, 0.19], [1.0, 0.39], [2.0, 0.53], [3.2, 0.62], [4.6, 0.69], [6.0, 0.74], [7.3, 0.8],
  [8.1, 1.05], [8.8, 1.7], [9.4, 1.95], [13.6, 1.95], [15.0, 1.85], [16.0, 1.72], [16.8, 1.62], [17.25, 1.58],
]);
const wcC = curve([[0, -0.3], [3, -0.2], [6, -0.08], [8.6, 0], [17.25, 0.02]]);
const tC = curve([
  [0, 0.004], [0.5, 0.16], [1.5, 0.32], [3.0, 0.42], [4.5, 0.46], [6.5, 0.5], [8.6, 0.52], [10.5, 0.52],
  [13.0, 0.5], [15.0, 0.45], [16.5, 0.4], [17.25, 0.36],
]);
const bC = curve([
  [0, 0.004], [0.5, 0.15], [1.5, 0.3], [3.0, 0.4], [4.5, 0.48], [6.0, 0.56], [8.6, 0.72], [13.0, 0.75],
  [15.0, 0.68], [16.3, 0.5], [17.25, 0.42],
]);
const nTC = curve([[0, 1.8], [3, 2.0], [8, 2.2], [9.5, 2.6], [15, 2.6], [17.25, 2.4]]);
const nBC = curve([[0, 1.8], [3, 2.2], [8, 3.0], [9.5, 4.0], [15, 4.0], [17.25, 3.0]]);

export const S_END = 17.25;

export function bodyParams(s) {
  return { a: aC(s), wc: wcC(s), t: tC(s), b: bC(s), nT: nTC(s), nB: nBC(s) };
}

const se = (x, n) => Math.pow(Math.max(0, 1 - Math.pow(Math.min(1, Math.abs(x)), n)), 1 / n);

/** Height of the upper skin at (s, y), or the chine height outside the body. */
export function topAt(s, y) {
  const p = bodyParams(s);
  return p.wc + p.t * se(y / p.a, p.nT);
}

/** Height of the lower skin at (s, y). */
export function botAt(s, y) {
  const p = bodyParams(s);
  return p.wc - p.b * se(y / p.a, p.nB);
}

const NQ = 16; // points per quadrant

/** Station ring, CCW from the bottom centre: starboard lower, starboard chine (doubled), top, port chine, port lower. */
export function bodyRing(s) {
  const p = bodyParams(s);
  const pts = [];
  const quad = (a0, a1, h, n, skipFirst) => {
    for (let i = skipFirst ? 1 : 0; i <= NQ; i++) {
      const ang = lerp(a0, a1, i / NQ);
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      const e = 2 / n;
      pts.push([s, p.a * Math.sign(c) * Math.pow(Math.abs(c), e), p.wc + h * Math.sign(sn) * Math.pow(Math.abs(sn), e)]);
    }
  };
  quad(-Math.PI / 2, 0, p.b, p.nB, false); // bottom centre -> starboard chine
  quad(0, Math.PI / 2, p.t, p.nT, false); // starboard chine (again: crease) -> top
  quad(Math.PI / 2, Math.PI, p.t, p.nT, true); // top -> port chine
  quad(Math.PI, 1.5 * Math.PI, p.b, p.nB, false); // port chine (again) -> bottom centre (excluded below)
  pts.pop(); // closed ring: the last point equals the first
  return pts;
}

export function buildFuselage() {
  const st = [];
  // dense at the nose, where curvature is highest
  for (let i = 0; i <= 18; i++) st.push(3.2 * Math.pow(i / 18, 1.6));
  for (const s of linspace(3.35, S_END, 70)) st.push(s);
  return loft(st.map(bodyRing), { closed: true, capStart: false, capEnd: true });
}

/* ------------------------------- Caret intakes ------------------------------- */

export const INTAKE = {
  sMouth: 5.95, // forward-most lip point (upper inner corner)
  sEnd: 10.6,
  lean: 0.55, // lower lip sits this far aft of the upper lip
  rake: 0.3, // outer lip sits this far aft of the inner lip
  wall: 0.06,
  sFan: 9.3,
};

/** Intake cross-section corners at station s: inner/outer y, top/bottom heights at each side. */
export function intakeSection(s) {
  const f = sstep(8.4, INTAKE.sEnd, s);
  return {
    yi: 0.72,
    yo: lerp(1.6, 1.86, sstep(6, 9, s)),
    wti: 0.24 - 0.06 * f,
    wto: 0.07,
    wbi: lerp(-0.76, -0.66, f),
    wbo: lerp(-0.6, -0.36, f),
  };
}

const EDGE_N = [8, 6, 8, 6]; // samples along bottom, outer, top, inner edges

/** Quad-ish section ring with creased corners, CCW (bottom inner -> bottom outer -> top outer -> top inner). */
function intakeRing(sec, inset, sOf) {
  const c = [
    [sec.yi + inset, sec.wbi + inset],
    [sec.yo - inset, sec.wbo + inset],
    [sec.yo - inset, sec.wto - inset],
    [sec.yi + inset, sec.wti - inset],
  ];
  const pts = [];
  for (let e = 0; e < 4; e++) {
    const A = c[e];
    const B = c[(e + 1) % 4];
    for (let k = 0; k <= EDGE_N[e]; k++) {
      const f = k / EDGE_N[e];
      const y = lerp(A[0], B[0], f);
      const w = lerp(A[1], B[1], f);
      pts.push([sOf(y, w, sec), y, w]);
    }
  }
  return pts;
}

/** Lip station for a point of the mouth: raked aft outboard and leaning aft towards the bottom. */
function mouthS(y, w, sec) {
  const fy = clamp((y - sec.yi) / (sec.yo - sec.yi), 0, 1);
  const fw = clamp((sec.wti - w) / (sec.wti - sec.wbi), 0, 1);
  return INTAKE.sMouth + INTAKE.lean * fw + INTAKE.rake * fy;
}

/** Starboard intake: outer shell, inner duct, lip and fan face (each design-frame geometry). */
export function buildIntake() {
  const I = INTAKE;
  const sec0 = intakeSection(I.sMouth);
  const us = linspace(0, 1, 26);
  const shell = us.map((u) => {
    const sNom = lerp(I.sMouth, I.sEnd, u);
    const sec = intakeSection(sNom);
    return intakeRing(sec, 0, (y, w) => lerp(mouthS(y, w, sec0), I.sEnd, u));
  });
  const ductRings = linspace(0, 1, 14).map((u) => {
    const sec = intakeSection(lerp(I.sMouth, I.sFan, u));
    return intakeRing(sec, I.wall, (y, w) => lerp(mouthS(y, w, sec0), I.sFan, u));
  });
  const lip = loft([intakeRing(sec0, 0, (y, w) => mouthS(y, w, sec0)), intakeRing(sec0, I.wall, (y, w) => mouthS(y, w, sec0) + 0.01)], {
    closed: true,
  });
  const secF = intakeSection(I.sFan);
  const fan = loft([intakeRing(secF, I.wall, () => I.sFan), intakeRing(secF, I.wall + 0.25, () => I.sFan)], { closed: true, capEnd: true });
  // duct colour: lighter at the lip, fading into darkness towards the engine face
  const ductGeo = loft(ductRings, {
    closed: true,
    flip: true,
    color: (i) => {
      const k = 1 - sstep(0, 0.75, i / (ductRings.length - 1));
      const v = 0.04 + 0.5 * k * k;
      return [v, v, v * 1.02];
    },
  });
  return {
    shell: loft(shell, { closed: true }),
    duct: ductGeo,
    lip,
    fan,
  };
}

export function mirrored(g) {
  return mirrorY(g);
}
