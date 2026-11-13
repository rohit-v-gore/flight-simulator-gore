import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { loft, mirrorY, sectionRing, ellipseRing, makeHinge, pivotMesh, makeMesh, finalize, mirrorPt, camberLine, Tp } from '../f22/geom.js';
import { DEG, clamp, lerp, sstep, linspace, approach, curve } from '../f22/util.js';

/*
 * Electric wing-in-ground-effect "seaglider" (generic, fictional COASTLINE livery).
 *
 * Built in the shared design frame (s metres aft of the nose tip, y starboard, w up; see f22/geom.js) and
 * converted to scene axes (X = -s, Y = w, Z = y). The model origin is the hull keel bottom (foil retracted)
 * under the hydrofoil strut, so the hull floats with its keel at y = 0 and the extended foil reaches below.
 */

const S_ORIGIN = 7.6; // design s of the model origin (hydrofoil strut / CG)
const TEX_LEN = 17; // hull texture length (m)
const HULL_END = 16.7;
const STEP_S = 9.0; // hull bottom step
const NOSE_C = 1.45; // nose tip height
const NOSE_L = 1.2; // length of the elliptical nose rounding
const FOIL_DROP = 1.5;

/* ------------------------------------------------------------------ hull ------------------------------------------------------------------ */

const topBase = curve([[0, 1.9], [0.6, 2.12], [1.5, 2.4], [2.4, 2.76], [3.2, 2.95], [3.8, 2.98], [10.6, 2.98], [12.6, 2.84], [14.6, 2.58], [16.7, 2.3]]);
const keelFore = curve([[0, 0.9], [1.0, 0.45], [2.0, 0.15], [3.2, 0.02], [4.2, 0], [STEP_S, 0]]);
const keelAft = curve([[STEP_S, 0.09], [11, 0.24], [13, 0.6], [15, 1.15], [16.7, 1.72]]);
const beamBase = curve([[0, 0.78], [1.2, 1.02], [2.6, 1.19], [4, 1.25], [10, 1.25], [12.5, 1.08], [14.6, 0.74], [16.7, 0.3]]);
const deadrise = curve([[0, 0.4], [4, 0.38], [9, 0.36], [13, 0.3], [16.7, 0.2]]);
const flareH = curve([[0, 0.24], [10, 0.24], [14, 0.2], [16.7, 0.12]]);

const U_CH = 0.12; // ring parameter of the chine
const U_FL = 0.17; // top of the chine flare (maximum beam)
const EXP = 0.77; // superellipse exponent of the topsides (2 / n, n = 2.6)

function hullSection(s) {
  const f = s < NOSE_L ? Math.sqrt(Math.max(0, 1 - (1 - s / NOSE_L) ** 2)) : 1;
  const keelB = s <= STEP_S ? keelFore(s) : keelAft(s);
  const chineB = keelB + deadrise(s);
  const wmB = chineB + flareH(s);
  const sc = (h) => NOSE_C + (h - NOSE_C) * f;
  const B = beamBase(s) * f;
  return { keel: sc(keelB), chine: sc(chineB), wm: sc(wmB), top: sc(topBase(s)), B, Bc: B * 0.9 };
}

/** Hull surface point for ring parameter u: 0 keel -> 0.12 chine -> 0.17 max beam -> 0.5 top -> port -> 1 keel. */
function hullPt(sec, s, u) {
  let side = 1;
  if (u > 0.5) {
    u = 1 - u;
    side = -1;
  }
  let y;
  let w;
  if (u <= U_CH) {
    const t = u / U_CH;
    y = sec.Bc * t;
    w = sec.keel + (sec.chine - sec.keel) * t ** 1.15;
  } else if (u <= U_FL) {
    const t = (u - U_CH) / (U_FL - U_CH);
    y = sec.Bc + (sec.B - sec.Bc) * Math.sin((t * Math.PI) / 2);
    w = sec.chine + (sec.wm - sec.chine) * t;
  } else {
    const p = ((u - U_FL) / (0.5 - U_FL)) * (Math.PI / 2);
    y = sec.B * Math.max(0, Math.cos(p)) ** EXP;
    w = sec.wm + (sec.top - sec.wm) * Math.sin(p) ** EXP;
  }
  return [s, side * y, w];
}

/** Starboard ring parameter at height w (inverse of hullPt). */
function uOfW(sec, w) {
  if (w >= sec.wm) {
    const q = clamp((w - sec.wm) / (sec.top - sec.wm), 0, 1);
    return U_FL + (Math.asin(q ** (1 / EXP)) / (Math.PI / 2)) * (0.5 - U_FL);
  }
  if (w >= sec.chine) return U_CH + ((w - sec.chine) / (sec.wm - sec.chine)) * (U_FL - U_CH);
  const t = clamp((w - sec.keel) / (sec.chine - sec.keel), 0, 1) ** (1 / 1.15);
  return t * U_CH;
}

/** Ring parameter from the topside angle phi (0 = starboard max beam, pi/2 = top, pi = port max beam). */
const uOfPhi = (phi) => U_FL + (phi / (Math.PI / 2)) * (0.5 - U_FL);

const U_STAR = [...linspace(0, U_CH, 9), U_CH, ...linspace(U_CH, U_FL, 4).slice(1), ...linspace(U_FL, 0.5, 26).slice(1)];
const U_LIST = [...U_STAR, ...U_STAR.slice(0, -1).reverse().map((u) => 1 - u)];

function hullStations() {
  const st = linspace(0, Math.PI / 2, 12).map((a) => NOSE_L * (1 - Math.cos(a)));
  for (let s = NOSE_L + 0.2; s < STEP_S - 0.01; s += 0.2) st.push(s);
  st.push(STEP_S, STEP_S + 0.03);
  for (let s = STEP_S + 0.2; s < HULL_END - 0.01; s += 0.2) st.push(s);
  st.push(HULL_END);
  return st;
}

/** Grid over the hull surface (s0..s1 x u0..u1) pushed out along the normal by `offset`; uv = (s / TEX_LEN, u). */
function hullGrid(stations, us, offset = 0, capEnd = false) {
  const pos = [];
  const uv = [];
  const idx = [];
  const nU = us.length;
  const e = 1e-3;
  for (const s of stations) {
    const sec = hullSection(s);
    const secA = offset ? hullSection(s + e) : null;
    const secB = offset ? hullSection(Math.max(0, s - e)) : null;
    for (const u of us) {
      const p = hullPt(sec, s, u);
      if (offset) {
        const pu = new THREE.Vector3(...hullPt(sec, s, u + e)).sub(new THREE.Vector3(...hullPt(sec, s, u - e)));
        const ps = new THREE.Vector3(...hullPt(secA, s + e, u)).sub(new THREE.Vector3(...hullPt(secB, Math.max(0, s - e), u)));
        const n = pu.cross(ps).normalize();
        p[0] += n.x * offset;
        p[1] += n.y * offset;
        p[2] += n.z * offset;
      }
      pos.push(...p);
      uv.push(s / TEX_LEN, u);
    }
  }
  for (let r = 0; r + 1 < stations.length; r++) {
    for (let k = 0; k + 1 < nU; k++) {
      const a = r * nU + k;
      idx.push(a, a + 1, a + 1 + nU, a, a + 1 + nU, a + nU);
    }
  }
  if (capEnd) {
    const r = stations.length - 1;
    const start = pos.length / 3;
    const c = [0, 0, 0];
    for (let k = 0; k < nU; k++) {
      const i = (r * nU + k) * 3;
      for (let j = 0; j < 3; j++) c[j] += pos[i + j] / nU;
      pos.push(pos[i], pos[i + 1], pos[i + 2]);
      uv.push(stations[r] / TEX_LEN, 0.46);
    }
    pos.push(...c);
    uv.push(stations[r] / TEX_LEN, 0.46);
    const mid = start + nU;
    for (let k = 0; k + 1 < nU; k++) idx.push(mid, start + k + 1, start + k);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

/* ----------------------------------------------------------------- livery ----------------------------------------------------------------- */

const COL = {
  white: '#f3f5f6',
  bottom: '#1d3245',
  ocean: '#0c5a8c',
  teal: '#14a3a8',
  navy: '#12304a',
  window: '#16222c',
  frame: '#5d6a74',
};

/** Windscreen panels as polygons in (s, phi); phi spans the top from starboard (0) to port (pi). */
const WS_PHI0 = 0.58;
function windscreenPanels() {
  const span = Math.PI / 2 - WS_PHI0;
  const sFront = (q) => 1.22 + 0.8 * Math.abs(q) ** 1.5;
  const sAft = (q) => 2.82 + 0.2 * q * q;
  const ranges = [[-1, -0.56], [-0.52, -0.018], [0.018, 0.52], [0.56, 1]];
  return ranges.map(([q0, q1]) => {
    const pts = [];
    const qs = linspace(q0, q1, 10);
    for (const q of qs) pts.push([sFront(q) + 0.03, Math.PI / 2 + q * span]);
    for (const q of qs.slice().reverse()) pts.push([sAft(q) - 0.03, Math.PI / 2 + q * span]);
    return pts;
  });
}

/** Cockpit side windows in (s, w). */
const SIDE_WINDOW = [[3.12, 2.1], [3.95, 2.1], [3.95, 2.6], [3.18, 2.66]];

function roundedRect(sc, wc, hs, hw, n = 4.5, count = 36) {
  const e = 2 / n;
  return Array.from({ length: count }, (_, i) => {
    const a = (2 * Math.PI * i) / count;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    return [sc + hs * Math.sign(c) * Math.abs(c) ** e, wc + hw * Math.sign(sn) * Math.abs(sn) ** e];
  });
}

function makePainter(ctx, W, H) {
  const px = (s) => (s / TEX_LEN) * W;
  const py = (u) => (1 - u) * H;
  const sw = (s, w, side) => {
    const u = uOfW(hullSection(s), w);
    return [px(s), py(side > 0 ? u : 1 - u)];
  };
  const poly = (pts, color) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
  };
  const polySW = (pts, side, color) => poly(pts.map(([s, w]) => sw(s, w, side)), color);
  const polySPhi = (pts, color) => poly(pts.map(([s, phi]) => [px(s), py(uOfPhi(phi))]), color);
  /** Band between two height functions along s, on one side. */
  const band = (s0, s1, lo, hi, side, color, n = 80) => {
    const ss = linspace(s0, s1, n);
    polySW([...ss.map((s) => [s, lo(s)]), ...ss.slice().reverse().map((s) => [s, hi(s)])], side, color);
  };
  /** Text laid on the hull side at (s, w), reading left-to-right as seen from that side. Size in metres. */
  const text = (str, s, w, side, size, color, weight = '700') => {
    const d = 0.01;
    const p0 = sw(s, w, side);
    const pr = sw(s - side * d, w, side);
    const pd = sw(s, w - d, side);
    const k = 0.01; // 1 canvas unit = 1 cm
    ctx.save();
    ctx.setTransform(((pr[0] - p0[0]) / d) * k, ((pr[1] - p0[1]) / d) * k, ((pd[0] - p0[0]) / d) * k, ((pd[1] - p0[1]) / d) * k, p0[0], p0[1]);
    ctx.fillStyle = color;
    ctx.font = `${weight} ${Math.round(size * 100)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(str, 0, 0);
    ctx.restore();
  };
  return { px, py, sw, poly, polySW, polySPhi, band, text };
}

function paintHull(maxAniso) {
  const W = 4096;
  const H = 2048;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const P = makePainter(ctx, W, H);
  ctx.fillStyle = COL.white;
  ctx.fillRect(0, 0, W, H);
  // antifouling bottom (below the chines) and the boot-top line
  ctx.fillStyle = COL.bottom;
  ctx.fillRect(0, P.py(U_CH), W, H - P.py(U_CH));
  ctx.fillRect(0, 0, W, P.py(1 - U_CH));
  ctx.fillStyle = COL.teal;
  ctx.fillRect(0, P.py(U_CH + 0.012), W, P.py(U_CH) - P.py(U_CH + 0.012));
  ctx.fillRect(0, P.py(1 - U_CH), W, P.py(1 - U_CH - 0.012) - P.py(1 - U_CH));
  // hydrofoil slot along the keel
  ctx.fillStyle = '#0b1219';
  ctx.fillRect(P.px(7.22), P.py(0.012), P.px(7.98) - P.px(7.22), P.py(0) - P.py(0.012));
  ctx.fillRect(P.px(7.22), P.py(1), P.px(7.98) - P.px(7.22), P.py(0.988) - P.py(1));

  const chine = (s) => hullSection(s).chine;
  const thick = curve([[0.5, 0.0], [2.2, 0.3], [7, 0.4], [12, 0.52], [15.2, 0.5], [16.7, 0.3]]);
  for (const side of [1, -1]) {
    // ocean-blue sweep that rises with the chine towards the tail, teal pinstripe above it
    P.band(0.5, HULL_END, (s) => chine(s) + 0.04, (s) => chine(s) + 0.04 + thick(s), side, COL.ocean);
    P.band(1.6, HULL_END, (s) => chine(s) + 0.1 + thick(s), (s) => chine(s) + 0.1 + thick(s) + 0.08 * sstep(1.6, 4, s), side, COL.teal);
    // passenger windows
    for (let i = 0; i < 8; i++) {
      const sc = 4.75 + i * 0.8;
      P.polySW(roundedRect(sc, 2.18, 0.25, 0.3), side, COL.frame);
      P.polySW(roundedRect(sc, 2.18, 0.21, 0.26), side, COL.window);
    }
    // cabin door (port) / emergency exit (starboard)
    const door = side < 0 ? [11.05, 11.95, 0.95, 2.62] : [11.15, 11.75, 1.65, 2.58];
    const [d0, d1, dlo, dhi] = door;
    P.polySW(roundedRect((d0 + d1) / 2, (dlo + dhi) / 2, (d1 - d0) / 2 + 0.02, (dhi - dlo) / 2 + 0.02, 6), side, '#8f9aa3');
    P.polySW(roundedRect((d0 + d1) / 2, (dlo + dhi) / 2, (d1 - d0) / 2, (dhi - dlo) / 2, 6), side, COL.white);
    if (side < 0) P.polySW(roundedRect((d0 + d1) / 2, 2.3, 0.18, 0.18), side, COL.window);
    // cockpit side window
    P.polySW(SIDE_WINDOW.map(([s, w]) => [s - 0.03, w + (w > 2.3 ? 0.03 : -0.03)]), side, '#2c353d');
    P.polySW(SIDE_WINDOW, side, COL.window);
    // name and markings
    P.text('COASTLINE', 7.0, 1.42, side, 0.44, COL.navy, '800');
    P.text('ELECTRIC SEAGLIDER', 7.0, 1.08, side, 0.15, COL.ocean, '600');
    P.text('CL-01', 13.9, 2.3, side, 0.2, COL.navy, '700');
  }
  // windscreen frame (the panels themselves are cut out of the skin)
  P.polySPhi([
    ...linspace(-1.04, 1.04, 14).map((q) => [1.19 + 0.8 * Math.abs(q) ** 1.5, Math.PI / 2 + q * (Math.PI / 2 - WS_PHI0)]),
    ...linspace(1.04, -1.04, 14).map((q) => [2.86 + 0.2 * q * q, Math.PI / 2 + q * (Math.PI / 2 - WS_PHI0)]),
  ], '#2c353d');
  for (const p of windscreenPanels()) P.polySPhi(p, COL.window);

  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = maxAniso;
  return map;
}

/** Alpha mask of the cockpit glazing: white = glass. `invert` gives the hull cut-out mask. */
function paintGlass(invert) {
  const W = 2048;
  const H = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const P = makePainter(ctx, W, H);
  const bg = invert ? '#fff' : '#000';
  const fg = invert ? '#000' : '#fff';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  for (const p of windscreenPanels()) P.polySPhi(p, fg);
  for (const side of [1, -1]) P.polySW(SIDE_WINDOW, side, fg);
  return new THREE.CanvasTexture(canvas);
}

/* ----------------------------------------------------------- lifting surfaces ----------------------------------------------------------- */

const WING = { yTip: 10, cRoot: 2.6, cTip: 1.45, sQC: 6.65, wRoot: 2.86, dihedral: 2 * DEG, tRoot: 0.16, tTip: 0.12, m: 0.03, flapX: 0.74 };

function wingFrame(y) {
  const u = y / WING.yTip;
  const c = lerp(WING.cRoot, WING.cTip, u);
  const le = WING.sQC - 0.25 * c;
  const w = WING.wRoot + y * Math.tan(WING.dihedral);
  return { le: [le, y, w], te: [le + c, y, w], up: [0, 0, 1], t: lerp(WING.tRoot, WING.tTip, u), m: WING.m };
}

/** Point on a frame's camber line (side 0) or surface (+1 upper / -1 lower) at chord fraction x. */
function framePt(f, x) {
  const chord = Math.hypot(f.te[0] - f.le[0], f.te[1] - f.le[1], f.te[2] - f.le[2]);
  const h = camberLine(x, f.m || 0) * chord;
  return [0, 1, 2].map((j) => f.le[j] + (f.te[j] - f.le[j]) * x + f.up[j] * h);
}

function band(frameFn, params, x0, x1, nChord, opts = {}) {
  const rings = params.map((p) => sectionRing(frameFn(p), typeof x0 === 'function' ? x0(p) : x0, typeof x1 === 'function' ? x1(p) : x1, nChord));
  return loft(rings, { closed: true, capStart: true, capEnd: true, ...opts });
}

const sided = (side, geo) => (side > 0 ? geo : mirrorY(geo));
const sidedPt = (side, p) => (side > 0 ? p : mirrorPt(p));

/** Hinged control surface between params a..b of a lifting surface, hinge on the camber line at x0. */
function controlSurface(parent, side, frameFn, a, b, x0, nSpan, mat, name) {
  const h0 = framePt(frameFn(a), x0);
  const h1 = framePt(frameFn(b), x0);
  const pivot = sidedPt(side, h0);
  const axis = sidedPt(side, [h1[0] - h0[0], h1[1] - h0[1], h1[2] - h0[2]]);
  const hinge = makeHinge(parent, pivot, axis, null, side);
  hinge.add(pivotMesh(sided(side, band(frameFn, linspace(a, b, nSpan), x0, 1, 12)), mat, pivot, name));
  return hinge;
}

/* ------------------------------------------------------------------ build ------------------------------------------------------------------ */

const MOTOR_Y = [1.95, 3.9, 5.85, 7.8];
const PROP_R = 0.86;

function bladeGeometry() {
  const rings = linspace(0.17, PROP_R, 12).map((r) => {
    const f = (r - 0.17) / (PROP_R - 0.17);
    const chord = 0.17 * Math.sqrt(Math.max(0.04, 1 - (f * 1.02) ** 2)) * (1 - 0.25 * f);
    const beta = Math.atan(1.3 / (2 * Math.PI * r));
    const th = 0.022 * (1 - 0.6 * f);
    return Array.from({ length: 10 }, (_, i) => {
      const a = (2 * Math.PI * i) / 10;
      const c = (Math.cos(a) * chord) / 2;
      const t = (Math.sin(a) * th) / 2;
      // chord direction in the disc plane rotated by the blade angle about the radial (Y) axis
      return [-Math.sin(beta) * c + Math.cos(beta) * t, r, Math.cos(beta) * c + Math.sin(beta) * t];
    });
  });
  const one = loft(rings, { closed: true, capEnd: true });
  const blades = [0, 1, 2, 3].map((k) => one.clone().rotateX((k * Math.PI) / 2));
  const geo = mergeGeometries(blades);
  geo.computeVertexNormals();
  return geo;
}

function discTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.2, 'rgba(255,255,255,0.25)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.45)');
  g.addColorStop(0.9, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.97, 'rgba(255,255,255,0.3)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

export function create(renderer) {
  const maxAniso = renderer?.capabilities?.getMaxAnisotropy?.() || 4;

  const mats = {
    hull: new THREE.MeshStandardMaterial({ map: paintHull(maxAniso), alphaMap: paintGlass(true), alphaTest: 0.5, roughness: 0.3, metalness: 0.05 }),
    inner: new THREE.MeshStandardMaterial({ color: 0x3b4248, roughness: 0.8, side: THREE.BackSide, alphaTest: 0.5 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x0b1a26, roughness: 0.04, metalness: 0.3, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide }),
    white: new THREE.MeshStandardMaterial({ color: 0xf1f3f4, roughness: 0.32, metalness: 0.05 }),
    ocean: new THREE.MeshStandardMaterial({ color: 0x0c5a8c, roughness: 0.3, metalness: 0.1 }),
    teal: new THREE.MeshStandardMaterial({ color: 0x14a3a8, roughness: 0.3, metalness: 0.1 }),
    foil: new THREE.MeshStandardMaterial({ color: 0x46515c, roughness: 0.35, metalness: 0.6 }),
    spinner: new THREE.MeshStandardMaterial({ color: 0x14a3a8, roughness: 0.25, metalness: 0.3 }),
    blade: new THREE.MeshStandardMaterial({ color: 0x23282d, roughness: 0.5, metalness: 0.2, side: THREE.DoubleSide, transparent: false, opacity: 1 }),
    disc: new THREE.MeshBasicMaterial({ color: 0x8c969e, map: discTexture(), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    panel: new THREE.MeshStandardMaterial({ color: 0x1d2227, roughness: 0.7 }),
    screen: new THREE.MeshBasicMaterial({ color: 0x2f7fa8 }),
    seat: new THREE.MeshStandardMaterial({ color: 0x5c6670, roughness: 0.9 }),
    navRed: new THREE.MeshBasicMaterial({ color: 0xff2a1a }),
    navGreen: new THREE.MeshBasicMaterial({ color: 0x20ff60 }),
    navWhite: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    beacon: new THREE.MeshBasicMaterial({ color: 0xff1a10 }),
  };
  mats.inner.alphaMap = mats.hull.alphaMap;
  mats.glass.alphaMap = paintGlass(false);

  const root = new THREE.Group();
  root.name = 'seaglider';
  const air = new THREE.Group();
  air.name = 'airframe';
  air.position.x = S_ORIGIN;
  root.add(air);

  /* hull: painted skin, dark interior (backfaces) and the cockpit glazing */
  const hullGeo = finalize(hullGrid(hullStations(), U_LIST, 0, true));
  const hull = new THREE.Mesh(hullGeo, mats.hull);
  hull.name = 'hull';
  hull.castShadow = hull.receiveShadow = true;
  const inner = new THREE.Mesh(hullGeo, mats.inner);
  inner.name = 'hullInterior';
  inner.receiveShadow = true;
  const glassStations = linspace(1.1, 4.05, 44);
  const glassU = linspace(uOfPhi(0.2), uOfPhi(Math.PI - 0.2), 60);
  const glass = new THREE.Mesh(finalize(hullGrid(glassStations, glassU, 0.006)), mats.glass);
  glass.name = 'glazing';
  glass.renderOrder = 2;
  air.add(hull, inner, glass);

  /* cockpit interior: instrument panel with displays, two seats */
  const box = (sx, sy, sz, mat, s, y, w, name) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    m.position.copy(Tp([s, y, w]));
    m.name = name;
    air.add(m);
    return m;
  };
  const panel = box(0.5, 0.3, 1.6, mats.panel, 2.62, 0, 2.2, 'instrumentPanel');
  panel.rotation.z = 0.3;
  for (const y of [-0.6, -0.2, 0.2, 0.6]) {
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.18), mats.screen);
    scr.position.set(-0.252, 0.02, y);
    scr.rotation.y = -Math.PI / 2;
    panel.add(scr);
  }
  for (const y of [-0.42, 0.42]) {
    box(0.5, 0.12, 0.5, mats.seat, 3.45, y, 1.55, 'seat');
    box(0.12, 0.75, 0.5, mats.seat, 3.75, y, 1.95, 'seatBack').rotation.z = 0.2;
  }

  /* wing-root fairing on the cabin roof */
  {
    const rs = linspace(5.0, 10.2, 26);
    const rings = rs.map((s) => {
      const t = (s - 5.0) / 5.2;
      const k = Math.sin(Math.PI * t) ** 0.6;
      return ellipseRing(s, 0, 2.62, 0.05 + 0.95 * k, 0.05 + 0.5 * Math.sin(Math.PI * clamp(t * 1.15, 0, 1)) ** 0.7, 0.25, 2.3, 36);
    });
    air.add(makeMesh(loft(rings, { capStart: true, capEnd: true }), mats.white, null, 'wingFairing'));
  }

  /* wing with two flaperons per side, eight motor nacelles, tip floats */
  const flaperons = [];
  const props = [];
  const bladeGeo = bladeGeometry();
  const discGeo = new THREE.RingGeometry(0.2, PROP_R + 0.02, 48).rotateY(Math.PI / 2);
  const spinnerGeo = new THREE.LatheGeometry(
    linspace(0, 1, 14).map((t) => new THREE.Vector2(Math.max(0.001, 0.235 * Math.sqrt(Math.max(0, 1 - t * t))), t * 0.42)),
    28,
  ).rotateZ(-Math.PI / 2);
  for (const side of [1, -1]) {
    const geos = [
      band(wingFrame, linspace(0, 1.3, 4), 0, 1, 28),
      band(wingFrame, linspace(1.3, 9.2, 24), 0, WING.flapX, 24),
      band(wingFrame, linspace(9.2, WING.yTip, 4), 0, 1, 28),
    ];
    air.add(makeMesh(sided(side, mergeGeometries(geos)), mats.white, null, 'wing'));
    flaperons.push({ side, inboard: true, hinge: controlSurface(air, side, wingFrame, 1.35, 5.0, WING.flapX, 10, mats.white, 'flaperonInboard') });
    flaperons.push({ side, inboard: false, hinge: controlSurface(air, side, wingFrame, 5.05, 9.15, WING.flapX, 10, mats.white, 'flaperonOutboard') });

    // nacelles, spinners and propellers on the leading edge
    for (const ym of MOTOR_Y) {
      const f = wingFrame(ym);
      const le = f.le[0];
      const wc = f.le[2] + 0.01;
      const s0 = le - 0.95;
      const len = 2.55;
      const rad = curve([[0, 0.235], [0.25, 0.27], [0.5, 0.25], [0.8, 0.15], [1, 0.03]]);
      const rings = linspace(0, 1, 22).map((t) => {
        const r = rad(t);
        return ellipseRing(s0 + t * len, ym, wc - 0.03 * t, r, r * 0.95, r, 2.1, 30);
      });
      air.add(makeMesh(sided(side, loft(rings, { capStart: true, capEnd: true })), mats.white, null, 'nacelle'));
      // teal intake ring behind the spinner
      const ringGeo = new THREE.TorusGeometry(0.24, 0.022, 8, 28).rotateY(Math.PI / 2);
      const intake = new THREE.Mesh(ringGeo, mats.teal);
      intake.position.copy(Tp([s0 + 0.05, side * ym, wc]));
      air.add(intake);

      const prop = new THREE.Group();
      prop.position.copy(Tp([s0 - 0.02, side * ym, wc]));
      air.add(prop);
      const spinner = new THREE.Mesh(spinnerGeo, mats.spinner);
      spinner.castShadow = true;
      const rotor = new THREE.Group();
      const blades = new THREE.Mesh(bladeGeo, mats.blade);
      blades.position.x = 0.12;
      blades.castShadow = true;
      if (side < 0) blades.scale.z = -1;
      const disc = new THREE.Mesh(discGeo, mats.disc);
      disc.position.x = 0.12;
      disc.renderOrder = 3;
      rotor.add(spinner, blades);
      prop.add(rotor, disc);
      props.push({ rotor, blades, side, phase: Math.random() * 6 });
    }

    // wingtip float on a streamlined strut
    const yf = 9.45;
    const fr = curve([[0, 0.02], [0.08, 0.17], [0.3, 0.25], [0.6, 0.23], [1, 0.03]]);
    const floatRings = linspace(0, 1, 24).map((t) => {
      const r = fr(t);
      return ellipseRing(5.3 + t * 2.9, yf, 0.72 + 0.12 * t, r * 0.95, r, r * 0.95, 2.4, 28);
    });
    air.add(makeMesh(sided(side, loft(floatRings, { capStart: true, capEnd: true })), mats.ocean, null, 'tipFloat'));
    const wt = wingFrame(yf);
    const strutFrame = (w) => {
      const k = (w - 0.8) / (wt.le[2] - 0.8);
      const le = lerp(6.0, wt.le[0] + 0.15, k);
      return { le: [le, yf, w], te: [le + lerp(1.05, 1.0, k), yf, w], up: [0, -1, 0], t: 0.13, m: 0 };
    };
    air.add(makeMesh(sided(side, band(strutFrame, linspace(0.8, wt.le[2] + 0.05, 8), 0, 1, 20)), mats.white, null, 'floatStrut'));

    // navigation light (green starboard / red port) and white strobe at the tip
    const tip = framePt(wingFrame(WING.yTip), 0.3);
    const nav = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), side > 0 ? mats.navGreen : mats.navRed);
    nav.position.copy(Tp(sidedPt(side, [tip[0], tip[1] + 0.03, tip[2]])));
    air.add(nav);
  }
  const strobes = [1, -1].map((side) => {
    const p = framePt(wingFrame(WING.yTip), 0.85);
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), mats.navWhite);
    m.position.copy(Tp(sidedPt(side, [p[0], p[1] + 0.03, p[2]])));
    air.add(m);
    return m;
  });

  /* T-tail: fin with rudder, swept horizontal stabilizer with elevators */
  const FIN_W0 = 2.1;
  const FIN_W1 = 4.86;
  const finFrame = (w) => {
    const u = (w - FIN_W0) / (FIN_W1 - FIN_W0);
    const le = lerp(13.25, 15.78, u);
    return { le: [le, 0, w], te: [lerp(16.55, 17.05, u), 0, w], up: [0, -1, 0], t: lerp(0.15, 0.12, u), m: 0 };
  };
  const RUD_X = 0.68;
  air.add(
    makeMesh(
      mergeGeometries([
        band(finFrame, linspace(FIN_W0, 2.75, 4), 0, 1, 26),
        band(finFrame, linspace(2.75, 4.72, 14), 0, RUD_X, 22),
        band(finFrame, linspace(4.72, FIN_W1, 3), 0, 1, 26),
      ]),
      mats.white,
      null,
      'fin',
    ),
  );
  const rudder = controlSurface(air, 1, finFrame, 2.77, 4.7, RUD_X, 10, mats.teal, 'rudder');

  const STAB_W = 4.93;
  const STAB_Y = 3.65;
  const stabFrame = (y) => {
    const u = Math.abs(y) / STAB_Y;
    const c = lerp(1.75, 1.0, u);
    const le = lerp(15.45, 16.42, u);
    return { le: [le, y, STAB_W], te: [le + c, y, STAB_W], up: [0, 0, 1], t: lerp(0.12, 0.1, u), m: 0 };
  };
  const ELEV_X = 0.64;
  air.add(
    makeMesh(
      mergeGeometries([
        band(stabFrame, [-STAB_Y, -3.5], 0, 1, 22),
        band(stabFrame, [...linspace(-3.5, -0.06, 10), ...linspace(0.06, 3.5, 10)], 0, ELEV_X, 20),
        band(stabFrame, [-0.06, 0.06], 0, 1, 22),
        band(stabFrame, [3.5, STAB_Y], 0, 1, 22),
      ]),
      mats.white,
      null,
      'stabilizer',
    ),
  );
  const elevators = [1, -1].map((side) => controlSurface(air, side, stabFrame, 0.06, 3.5, ELEV_X, 8, mats.white, 'elevator'));
  {
    // bullet fairing at the fin / stabilizer junction
    const br = curve([[0, 0.02], [0.15, 0.13], [0.6, 0.14], [1, 0.02]]);
    const rings = linspace(0, 1, 18).map((t) => {
      const r = br(t);
      return ellipseRing(15.35 + t * 2.0, 0, STAB_W, r, r, r, 2, 20);
    });
    air.add(makeMesh(loft(rings, { capStart: true, capEnd: true }), mats.teal, null, 'tailBullet'));
  }
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), mats.beacon);
  beacon.position.copy(Tp([16.2, 0, STAB_W + 0.17]));
  air.add(beacon);
  const tailLight = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), mats.navWhite);
  tailLight.position.copy(Tp([17.36, 0, STAB_W]));
  air.add(tailLight);

  /* retractable hydrofoil: strut + V foil, modelled retracted (inside the hull) and lowered by FOIL_DROP */
  const foil = new THREE.Group();
  foil.name = 'hydrofoil';
  air.add(foil);
  {
    const strutFrame = (w) => ({ le: [7.3, 0, w], te: [7.94, 0, w], up: [0, -1, 0], t: 0.12, m: 0 });
    foil.add(makeMesh(band(strutFrame, linspace(0.05, 1.75, 6), 0, 1, 22), mats.foil, null, 'foilStrut'));
    const G = 19.5 * DEG;
    const foilFrame = (y) => {
      const c = lerp(0.58, 0.36, y / 1.05);
      const le = 7.35 + (0.58 - c) * 0.35;
      const w = 0.045 + y * Math.tan(G);
      return { le: [le, y, w], te: [le + c, y, w], up: [0, -Math.sin(G), Math.cos(G)], t: 0.1, m: 0.02 };
    };
    for (const side of [1, -1]) foil.add(makeMesh(sided(side, band(foilFrame, linspace(0, 1.05, 10), 0, 1, 22)), mats.foil, null, 'foilWing'));
  }

  root.traverse((o) => {
    if (o.isMesh && o.material !== mats.disc && o.material !== mats.glass && o !== inner && !o.material.isMeshBasicMaterial) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });

  /* ------------------------------------------------------------- animation ------------------------------------------------------------- */
  const cur = { foil: 1, flap: 0, roll: 0, pitch: 0, yaw: 0, thr: 0, spin: 0, init: false };
  const FLAP = { up: 0, takeoff: 15, landing: 30 };

  function update(dt, s) {
    if (!cur.init) {
      cur.foil = s.gearDown ? 1 : 0;
      cur.flap = FLAP[s.flaps] ?? 0;
      cur.thr = s.throttle || 0;
      cur.init = true;
    }
    cur.foil = approach(cur.foil, s.gearDown ? 1 : 0, 1 / 3, dt);
    foil.position.y = -FOIL_DROP * sstep(0, 1, cur.foil);

    cur.flap = approach(cur.flap, FLAP[s.flaps] ?? 0, 12, dt);
    cur.roll = approach(cur.roll, clamp(s.roll || 0, -1, 1), 4, dt);
    cur.pitch = approach(cur.pitch, clamp(s.pitch || 0, -1, 1), 4, dt);
    cur.yaw = approach(cur.yaw, clamp(s.yaw || 0, -1, 1), 4, dt);
    for (const f of flaperons) {
      const ail = (f.inboard ? 8 : 20) * cur.roll;
      // positive angle = trailing edge down; roll right raises the starboard surfaces
      f.hinge.userData.set((cur.flap - f.side * ail) * DEG);
    }
    for (const e of elevators) e.userData.set(-22 * cur.pitch * DEG);
    rudder.userData.set(25 * cur.yaw * DEG);

    cur.thr = approach(cur.thr, clamp(s.throttle || 0, 0, 1), 0.8, dt);
    const rps = cur.thr * 26; // rev/s
    cur.spin = (cur.spin + rps * 2 * Math.PI * dt) % (Math.PI * 2000);
    const blur = sstep(0.12, 0.45, cur.thr);
    const solid = 1 - sstep(0.35, 0.6, cur.thr);
    mats.disc.opacity = 0.32 * blur;
    mats.blade.transparent = solid < 1;
    mats.blade.opacity = solid;
    mats.blade.depthWrite = solid >= 1;
    for (const p of props) {
      p.rotor.rotation.x = p.side * (cur.spin + p.phase);
      p.blades.visible = solid > 0.01;
    }

    const t = s.time || 0;
    beacon.visible = t % 1.2 < 0.15;
    const strobe = t % 1.0 > 0.5 && t % 1.0 < 0.56;
    for (const m of strobes) m.visible = strobe;
  }

  return {
    id: 'seaglider',
    name: 'Seaglider (electric WIG)',
    root,
    eye: [S_ORIGIN - 3.15, 2.68, -0.42],
    chaseDistance: 35,
    waterline: 0.35,
    update,
  };
}
