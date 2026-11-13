import * as THREE from 'three';
import { loft, mirrorY, makeMesh, pivotMesh, makeHinge, nacaHalf, Tp, mirrorPt } from '../f22/geom.js';
import { DEG, clamp, lerp, sstep, approach, curve, linspace, spow } from '../f22/util.js';

/*
 * Procedural Concorde. Parts are designed in the F-22 design frame (s = metres aft of the nose-probe tip,
 * y = metres to starboard, w = metres above the ground with the gear down) and placed in an `airframe`
 * group shifted so the root origin sits on the ground under the main-gear bogies (s = S_MAIN).
 */

const L = 61.66; // overall length incl. nose probe
const S_MAIN = 34.0; // main bogie centre
const S_NOSEGEAR = 15.8;
const S_HINGE = 7.8; // droop-nose hinge station
const PROBE = 1.6; // nose probe length (fuselage cone starts here)

/* ------------------------------ fuselage profile ------------------------------ */

const ryC = curve([[PROBE, 0.04], [2.6, 0.27], [4, 0.53], [5.5, 0.77], [7, 0.98], [8.5, 1.16], [10, 1.3], [11.5, 1.39], [13, 1.44], [14.5, 1.45], [44, 1.45], [47, 1.42], [50, 1.32], [53, 1.13], [56, 0.86], [58.5, 0.58], [60.5, 0.3], [L, 0.06]]);
const topC = curve([[PROBE, 4.47], [4, 4.95], [6, 5.3], [7.8, 5.6], [9.3, 5.92], [10.8, 6.12], [12.5, 6.2], [14, 6.22], [45, 6.22], [49, 6.18], [53, 6.08], [57, 5.92], [60, 5.8], [L, 5.68]]);
const botC = curve([[PROBE, 4.39], [3, 4.15], [5, 3.8], [7.5, 3.45], [10, 3.15], [12.5, 2.98], [14, 2.93], [41, 2.93], [44, 2.97], [47, 3.15], [50, 3.5], [53, 3.98], [56, 4.55], [59, 5.08], [L, 5.5]]);
const FUS_N = 2.15; // cross-section superellipse exponent
const RING = 72; // points around the fuselage

function fusPt(s, a, d = 0) {
  const ry = ryC(s) + d;
  const top = topC(s);
  const bot = botC(s);
  const wc = (top + bot) / 2;
  const rh = (top - bot) / 2 + d;
  const e = 2 / FUS_N;
  return [s, ry * spow(Math.cos(a), e), wc + rh * spow(Math.sin(a), e)];
}

/** Open (seamed) tube over stations `ss`, angles a0..a1 with `n` segments; adds uv = (s/L, angle fraction). */
function shell(ss, a0, a1, n, d, uvFn) {
  const rings = ss.map((s) => Array.from({ length: n + 1 }, (_, i) => fusPt(s, a0 + ((a1 - a0) * i) / n, d)));
  const geo = loft(rings, { closed: false });
  const uv = [];
  ss.forEach((s, ri) => {
    for (let i = 0; i <= n; i++) uv.push(...uvFn(s, i / n, ri));
  });
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geo;
}

/** Average the normals of the duplicated seam vertices of a full-circle shell (ring length n+1). */
function weldSeam(geo, n) {
  const nor = geo.attributes.normal;
  const rings = nor.count / (n + 1);
  for (let r = 0; r < rings; r++) {
    const a = r * (n + 1);
    const b = a + n;
    const v = new THREE.Vector3(nor.getX(a) + nor.getX(b), nor.getY(a) + nor.getY(b), nor.getZ(a) + nor.getZ(b)).normalize();
    nor.setXYZ(a, v.x, v.y, v.z);
    nor.setXYZ(b, v.x, v.y, v.z);
  }
}

/* -------------------------------- wing planform -------------------------------- */

const Y_ROOT = 0.6;
const Y_TIP = 12.8;
const LE = curve([[0.6, 20.6], [1.45, 21.6], [1.8, 23.0], [2.3, 25.0], [2.9, 27.0], [3.6, 28.9], [4.5, 30.8], [5.5, 32.6], [7.0, 35.2], [8.5, 37.8], [10.0, 40.6], [11.2, 43.3], [12.0, 45.6], [12.45, 47.6], [12.7, 49.3], [12.8, 50.2]]);
const TE = (y) => lerp(52.4, 51.2, (y - Y_ROOT) / (Y_TIP - Y_ROOT));
const chordAt = (y) => TE(y) - LE(y);
const wingBase = (y) => 3.62 - 0.018 * (y - Y_ROOT) - 0.0028 * (y - Y_ROOT) ** 2;
const thickAt = (y) => lerp(0.03, 0.026, (y - Y_ROOT) / (Y_TIP - Y_ROOT));
const droopAt = (y) => 0.004 + 0.026 * sstep(1.5, 12.8, y); // conical camber: LE droop (fraction of chord)
const camber = (x, y) => -droopAt(y) * Math.max(0, 1 - x / 0.32) ** 2 + 0.004 * Math.sin(Math.PI * x);
const ELEVON_CHORD = 2.3;
const hingeX = (y) => 1 - Math.min(ELEVON_CHORD, 0.42 * chordAt(y)) / chordAt(y);

function wingPt(y, x, side) {
  const c = chordAt(y);
  const half = Math.max(nacaHalf(x, thickAt(y)) * c, x > 0.995 ? 0.004 : 0);
  return [LE(y) + x * c, y, wingBase(y) + c * camber(x, y) + side * half];
}

/** Airfoil ring through chord fractions xs (ascending): upper surface, aft face, lower surface, fore face. */
function airRing(F, xs) {
  const x0 = xs[0];
  const x1 = xs[xs.length - 1];
  const ring = xs.map((x) => F(x, 1));
  const aftFace = x1 < 0.999;
  const foreFace = x0 > 0.001;
  if (aftFace) ring.push(F(x1, 1), F(x1, -1), F(x1, -1));
  else ring.push(F(x1, -1));
  for (let i = xs.length - 2; i >= (foreFace ? 0 : 1); i--) ring.push(F(xs[i], -1));
  if (foreFace) ring.push(F(x0, -1), F(x0, 1));
  return ring;
}

/** Lower-surface height of the wing at (s, y), clamped to the chord. */
function wingLowerAt(s, y) {
  const x = clamp((s - LE(y)) / chordAt(y), 0, 1);
  return wingPt(y, x, -1)[2];
}

/* ------------------------------------ livery ------------------------------------ */

function canvasTex(w, h, draw, renderer) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return t;
}

const BLUE = '#132f6b';

function fuselageLivery(renderer) {
  return canvasTex(4096, 1024, (g, W, H) => {
    g.fillStyle = '#f4f5f6';
    g.fillRect(0, 0, W, H);
    const pxS = W / L;
    const circ = 2 * Math.PI * 1.55;
    const pxV = H / circ;
    const R = 1.6; // nominal section radius for height -> angle
    const X = (s) => s * pxS;
    // angle a (radians, 0 = starboard side, pi/2 = top) on a side (+1 starboard, -1 port) -> canvas y
    const Yc = (a, side) => {
      const ang = side > 0 ? a : Math.PI - a;
      const v = (ang + Math.PI / 2) / (2 * Math.PI);
      return (1 - v) * H;
    };
    const angOf = (dh) => Math.asin(clamp(dh / R, -1, 1));
    for (const side of [1, -1]) {
      // cheatline
      const yA = Yc(angOf(-0.03), side);
      const yB = Yc(angOf(-0.14), side);
      g.fillStyle = BLUE;
      g.fillRect(X(4.5), Math.min(yA, yB), X(57.5) - X(4.5), Math.abs(yB - yA));
      // thin pinstripe above windows
      const p1 = Yc(angOf(0.62), side);
      const p2 = Yc(angOf(0.66), side);
      g.fillRect(X(11), Math.min(p1, p2), X(50) - X(11), Math.abs(p2 - p1));
      // doors
      const doors = [11.0, 27.4, 43.4];
      g.strokeStyle = '#9aa0a8';
      g.lineWidth = 2;
      for (const ds of doors) {
        const y1 = Yc(angOf(0.95), side);
        const y2 = Yc(angOf(-0.8), side);
        g.beginPath();
        g.roundRect(X(ds - 0.42), Math.min(y1, y2), X(0.84), Math.abs(y2 - y1), 8);
        g.stroke();
        // door window
        g.fillStyle = '#1b2430';
        const wy = Yc(angOf(0.42), side);
        g.beginPath();
        g.roundRect(X(ds - 0.07), wy - 9, X(0.14), 18, 5);
        g.fill();
      }
      // passenger windows
      g.fillStyle = '#1b2430';
      const wy = Yc(angOf(0.32), side);
      const wh = 0.24 * pxV;
      for (let s = 12.4; s < 43.6; s += 0.5) {
        if (doors.some((d) => Math.abs(s - d) < 0.65)) continue;
        g.beginPath();
        g.roundRect(X(s) - 0.075 * pxS, wy - wh / 2, 0.15 * pxS, wh, 4);
        g.fill();
      }
      // cockpit side windows (behind the windscreen)
      g.fillStyle = '#111820';
      const c1 = Yc(0.62, side);
      const c2 = Yc(0.98, side);
      for (const [sa, sb] of [[9.35, 10.05], [10.2, 10.75]]) {
        g.beginPath();
        g.moveTo(X(sa), c2);
        g.lineTo(X(sb - 0.12), c2);
        g.lineTo(X(sb), c1);
        g.lineTo(X(sa), c1);
        g.closePath();
        g.fill();
      }
      // fictional name + registration
      const text = (str, sCentre, hCentre, size, color, weight = 'bold') => {
        g.save();
        g.translate(X(sCentre), Yc(angOf(hCentre), side));
        // starboard: canvas x runs aft = leftwards on screen, so mirror horizontally;
        // port: canvas y runs downwards on screen, so mirror vertically.
        g.scale((side > 0 ? -1 : 1) * pxS * size / 100, (side > 0 ? 1 : -1) * pxV * size / 100);
        g.font = `${weight} 100px "Helvetica Neue", Helvetica, Arial, sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillStyle = color;
        g.fillText(str, 0, 0);
        g.restore();
      };
      text('SUPERSONIC', 18.2, 0.93, 0.42, BLUE);
      text('SST-01', 52.0, 0.25, 0.3, '#30343a', '600');
    }
  }, renderer);
}

function windscreenTex(renderer) {
  return canvasTex(256, 256, (g, W, H) => {
    g.fillStyle = '#0d131a';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#5d636b';
    for (const v of [0.0, 0.2, 0.38, 0.5, 0.62, 0.8, 1.0]) g.fillRect(0, v * H - 4, W, 8);
    g.fillRect(0, 0, 10, H);
    g.fillRect(W - 10, 0, 10, H);
  }, renderer);
}

function visorTex(renderer) {
  return canvasTex(256, 256, (g, W, H) => {
    g.fillStyle = '#f4f5f6';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#10161d';
    // two long narrow visor windows either side of the centre post
    g.fillRect(W * 0.4, H * 0.37, W * 0.5, H * 0.115);
    g.fillRect(W * 0.4, H * 0.515, W * 0.5, H * 0.115);
  }, renderer);
}

/* ------------------------------------ helpers ------------------------------------ */

function shade(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function strut(a, b, r, mat, seg = 14) {
  const span = new THREE.Vector3().subVectors(b, a);
  const bar = shade(new THREE.Mesh(new THREE.CylinderGeometry(r, r, span.length(), seg), mat));
  bar.position.addVectors(a, b).multiplyScalar(0.5);
  bar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), span.normalize());
  return bar;
}

function wheel(radius, width, mats) {
  const g = new THREE.Group();
  const tyre = shade(new THREE.Mesh(new THREE.TorusGeometry(radius - width / 2, width / 2, 12, 32), mats.rubber));
  tyre.scale.z = 0.9;
  const hub = shade(new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.6, radius * 0.6, width * 0.8, 24), mats.hub));
  hub.rotation.x = Math.PI / 2;
  g.add(tyre, hub);
  return g;
}

/* ------------------------------------- build ------------------------------------- */

export function create(renderer) {
  const root = new THREE.Group();
  root.name = 'Concorde';
  const airframe = new THREE.Group();
  airframe.position.x = S_MAIN; // scene X = S_MAIN - s
  root.add(airframe);

  const mats = {
    body: new THREE.MeshStandardMaterial({ map: fuselageLivery(renderer), roughness: 0.36, metalness: 0.02 }),
    wing: new THREE.MeshStandardMaterial({ color: 0xeef0f2, roughness: 0.42, metalness: 0.02 }),
    nacelle: new THREE.MeshStandardMaterial({ color: 0xe3e6e9, roughness: 0.45, metalness: 0.05 }),
    nozzle: new THREE.MeshStandardMaterial({ color: 0x75787d, roughness: 0.5, metalness: 0.55 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.8, metalness: 0.1 }),
    duct: new THREE.MeshStandardMaterial({ color: 0x55595f, roughness: 0.6, metalness: 0.3, side: THREE.DoubleSide }),
    lip: new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.35, metalness: 0.5, side: THREE.DoubleSide }),
    cap: new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.7 }),
    glass: new THREE.MeshStandardMaterial({ map: windscreenTex(renderer), roughness: 0.08, metalness: 0.4 }),
    visor: new THREE.MeshStandardMaterial({ map: visorTex(renderer), roughness: 0.3, metalness: 0.05 }),
    gear: new THREE.MeshStandardMaterial({ color: 0xc3c7cc, roughness: 0.35, metalness: 0.75 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x1d1d1e, roughness: 0.92 }),
    hub: new THREE.MeshStandardMaterial({ color: 0x9a9fa6, roughness: 0.4, metalness: 0.7 }),
    panel: new THREE.MeshStandardMaterial({ color: 0x141619, roughness: 0.85 }),
    glow: new THREE.MeshBasicMaterial({ color: 0xff7a2a, transparent: true, opacity: 0.0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
  };

  /* ---------------- fuselage (fixed part, aft of the droop hinge) ---------------- */
  const uvFus = (s, f) => [s / L, f];
  const bodyStations = [];
  for (let s = S_HINGE; s < 14; s += 0.3) bodyStations.push(s);
  for (let s = 14; s < 44; s += 1.0) bodyStations.push(s);
  for (let s = 44; s < L - 0.05; s += 0.45) bodyStations.push(s);
  bodyStations.push(L - 0.02);
  const bodyGeo = shell(bodyStations, -Math.PI / 2, 1.5 * Math.PI, RING, 0, uvFus);
  // close the tail and the hinge face
  const body = makeMesh(bodyGeo, mats.body, null, 'fuselage');
  weldSeam(bodyGeo, RING);
  airframe.add(body);
  const hingeCap = makeMesh(loft([Array.from({ length: RING }, (_, i) => fusPt(S_HINGE + 0.01, -Math.PI / 2 + (2 * Math.PI * i) / RING))], { capStart: true }), mats.cap, null, 'hingeCap');
  airframe.add(hingeCap);

  /* ------------------------------ droop nose + probe ------------------------------ */
  const hingePt = [S_HINGE, 0, botC(S_HINGE) + 0.02];
  const noseHinge = makeHinge(airframe, hingePt, [0, 1, 0]);
  const noseStations = [];
  for (let i = 0; i <= 26; i++) noseStations.push(PROBE + (S_HINGE - PROBE) * (1 - Math.cos((Math.PI / 2) * i / 26)));
  noseStations[noseStations.length - 1] = S_HINGE;
  const noseGeo = shell(noseStations, -Math.PI / 2, 1.5 * Math.PI, RING, 0, uvFus);
  const nose = pivotMesh(noseGeo, mats.body, hingePt, 'droopNose');
  weldSeam(noseGeo, RING);
  noseHinge.add(nose);
  // nose tip and probe
  const tipGeo = new THREE.ConeGeometry(0.045, 0.6, 12);
  tipGeo.rotateZ(Math.PI / 2);
  const tip = shade(new THREE.Mesh(tipGeo, mats.nozzle));
  tip.position.copy(Tp([PROBE + 0.28, 0, (topC(PROBE) + botC(PROBE)) / 2]).sub(Tp(hingePt)));
  const probe = strut(Tp([0.05, 0, 4.43]).sub(Tp(hingePt)), Tp([PROBE + 0.05, 0, 4.43]).sub(Tp(hingePt)), 0.025, mats.nozzle, 8);
  noseHinge.add(tip, probe);

  /* ------------------------------ windscreen and visor ------------------------------ */
  const wsStations = linspace(S_HINGE + 0.05, 9.3, 8);
  const ws = makeMesh(shell(wsStations, 26 * DEG, 154 * DEG, 28, 0.012, (s, f) => [(s - wsStations[0]) / (9.3 - wsStations[0]), f]), mats.glass, null, 'windscreen');
  airframe.add(ws);
  const visor = new THREE.Group();
  airframe.add(visor);
  const vStations = linspace(S_HINGE + 0.02, 9.5, 10);
  const visorMesh = makeMesh(shell(vStations, 22 * DEG, 158 * DEG, 32, 0.035, (s, f) => [(s - vStations[0]) / (9.5 - vStations[0]), f]), mats.visor, null, 'visor');
  visor.add(visorMesh);
  // glareshield for the cockpit view (hidden behind the opaque glass from outside)
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.3, 2.1), mats.panel);
  panel.position.copy(Tp([8.85, 0, 5.2]));
  airframe.add(panel);

  /* -------------------------------------- wing -------------------------------------- */
  const wingStations = [];
  const NW = 60;
  for (let i = 0; i < NW; i++) wingStations.push(Y_ROOT + (Y_TIP - Y_ROOT) * Math.sin((Math.PI / 2) * i / (NW - 1)));
  wingStations[NW - 1] = Y_TIP - 0.002;
  const NX = 34;
  const frontXs = (y) => {
    const xh = hingeX(y);
    return Array.from({ length: NX }, (_, i) => xh * (1 - Math.cos((Math.PI / 2) * i / (NX - 1))));
  };
  const wingRings = wingStations.map((y) => airRing((x, side) => wingPt(y, x, side), frontXs(y)));
  const wingGeo = loft(wingRings, { capEnd: true });
  const wingGeoP = mirrorY(wingGeo);
  airframe.add(makeMesh(wingGeo, mats.wing, null, 'wingR'), makeMesh(wingGeoP, mats.wing, null, 'wingL'));

  // trailing-edge pieces: fixed fillers and six elevons
  const GAP = 0.04;
  const elevons = [];
  const tePieces = [
    { y0: Y_ROOT, y1: 1.52, moving: false },
    { y0: 1.56, y1: 4.2, moving: true },
    { y0: 4.24, y1: 7.06, moving: false },
    { y0: 7.1, y1: 9.48, moving: true },
    { y0: 9.52, y1: 11.9, moving: true },
    { y0: 11.94, y1: Y_TIP - 0.002, moving: false },
  ];
  for (const p of tePieces) {
    const ys = linspace(p.y0, p.y1, Math.max(3, Math.ceil((p.y1 - p.y0) / 0.25)));
    const rings = ys.map((y) => {
      const c = chordAt(y);
      const x0 = hingeX(y) + GAP / c;
      return airRing((x, side) => wingPt(y, x, side), linspace(x0, 1, 7));
    });
    const geo = loft(rings, { capStart: true, capEnd: true });
    if (!p.moving) {
      const geoP = mirrorY(geo);
      airframe.add(makeMesh(geo, mats.wing, null, 'teFixed'), makeMesh(geoP, mats.wing, null, 'teFixed'));
      continue;
    }
    const hp = (y) => {
      const x = hingeX(y);
      return [LE(y) + x * chordAt(y), y, wingBase(y) + chordAt(y) * camber(x, y)];
    };
    const a = hp(p.y0);
    const b = hp(p.y1);
    const axis = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const geoP = mirrorY(geo);
    for (const side of [1, -1]) {
      const pivot = side > 0 ? a : mirrorPt(a);
      const ax = side > 0 ? axis : mirrorPt(axis);
      const hinge = makeHinge(airframe, pivot, ax, null, side);
      hinge.add(pivotMesh(side > 0 ? geo : geoP, mats.wing, pivot, 'elevon'));
      hinge.userData.side = side;
      hinge.userData.angle = 0;
      elevons.push(hinge);
    }
  }

  /* -------------------------------------- fin -------------------------------------- */
  const FIN_W0 = 5.5;
  const FIN_W1 = 12.2;
  const finLE = (w) => lerp(45.6, 53.4, (w - FIN_W0) / (FIN_W1 - FIN_W0));
  const finTE = (w) => lerp(58.8, 57.8, (w - FIN_W0) / (FIN_W1 - FIN_W0));
  const finT = (w) => lerp(0.036, 0.03, (w - FIN_W0) / (FIN_W1 - FIN_W0));
  const RUD_X = 0.72;
  const finPt = (w, x, side) => {
    const c = finTE(w) - finLE(w);
    const half = Math.max(nacaHalf(x, finT(w)) * c, x > 0.995 ? 0.004 : 0);
    return [finLE(w) + x * c, side * half, w];
  };
  const finWs = linspace(FIN_W0, FIN_W1 - 0.002, 24);
  const finRings = finWs.map((w) => airRing((x, side) => finPt(w, x, side), Array.from({ length: 26 }, (_, i) => RUD_X * (1 - Math.cos((Math.PI / 2) * i / 25)))));
  airframe.add(makeMesh(loft(finRings, { capEnd: true, flip: true }), mats.wing, null, 'fin'));
  const rudPiece = (w0, w1, x0) => loft(linspace(w0, w1, 8).map((w) => airRing((x, side) => finPt(w, x, side), linspace(x0 + 0.04 / (finTE(w) - finLE(w)), 1, 7))), { capStart: true, capEnd: true, flip: true });
  airframe.add(makeMesh(rudPiece(FIN_W0, 6.25, RUD_X), mats.wing, null, 'finFill'));
  const rudders = [];
  for (const [w0, w1] of [[6.29, 9.2], [9.24, FIN_W1 - 0.002]]) {
    const a = [finLE(w0) + RUD_X * (finTE(w0) - finLE(w0)), 0, w0];
    const b = [finLE(w1) + RUD_X * (finTE(w1) - finLE(w1)), 0, w1];
    const hinge = makeHinge(airframe, a, [b[0] - a[0], 0, b[2] - a[2]]);
    hinge.add(pivotMesh(rudPiece(w0, w1, RUD_X), mats.wing, a, 'rudder'));
    hinge.userData.angle = 0;
    rudders.push(hinge);
  }

  /* ------------------------------------ nacelles ------------------------------------ */
  const NAC_FRONT = 38.6;
  const NAC_HW = 0.68;
  const NOZ_START = 50.8;
  const NOZ_END = 52.8;
  const RAKE = 0.75;
  const engines = [4.95, 6.31];
  const flames = [];
  const glows = [];
  const NP = 48;
  for (const yc of engines) {
    const top = (s) => Math.max(wingLowerAt(s, yc - 0.6), wingLowerAt(s, yc), wingLowerAt(s, yc + 0.6)) + 0.12;
    const botBox = (s) => 1.55 + 0.035 * (s - NAC_FRONT);
    const nozC = top(NOZ_START) - 0.72;
    const nozR = 0.62;
    const dims = (s) => {
      const t = sstep(47.6, NOZ_START, s);
      const tp = top(Math.min(s, 47.6));
      const bt = botBox(Math.min(s, 47.6));
      const wc = lerp((tp + bt) / 2, nozC, t);
      const rh = lerp((tp - bt) / 2, nozR, t);
      const hw = lerp(NAC_HW, nozR, t);
      const n = lerp(9, 2, t);
      return { wc, rh, hw, n };
    };
    const ringAt = (s, inset = 0, rakeOn = true) => {
      const { wc, rh, hw, n } = dims(s);
      const e = 2 / n;
      const rakeF = rakeOn ? clamp(1 - (s - NAC_FRONT) / 3, 0, 1) : 0;
      return Array.from({ length: NP }, (_, i) => {
        const a = -Math.PI / 2 + (2 * Math.PI * i) / NP;
        const y = yc + (hw - inset) * spow(Math.cos(a), e);
        const w = wc + (rh - inset) * spow(Math.sin(a), e);
        const frac = (wc + rh - w) / (2 * rh); // 0 at top, 1 at bottom
        return [s + RAKE * rakeF * frac, y, w];
      });
    };
    const ss = [NAC_FRONT, NAC_FRONT + 0.06, NAC_FRONT + 0.25, NAC_FRONT + 0.6, NAC_FRONT + 1.2, NAC_FRONT + 2];
    for (let s = NAC_FRONT + 3; s < 47.5; s += 1.2) ss.push(s);
    for (let s = 47.6; s <= NOZ_START + 1e-6; s += 0.32) ss.push(s);
    const outerRings = ss.map((s) => ringAt(s));
    const nozRing = (s, r) => Array.from({ length: NP }, (_, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / NP;
      return [s, yc + r * Math.cos(a), nozC + r * Math.sin(a)];
    });
    // outer nacelle skin (lip ring is the first ring, slightly inset)
    const lipIn = ringAt(NAC_FRONT, 0.07);
    const nacGeo = loft(outerRings);
    const lipGeo = loft([lipIn, outerRings[0]]);
    const ductGeo = loft([lipIn, ...[0.4, 1.0, 2.2].map((d) => ringAt(NAC_FRONT + d, 0.07 + d * 0.03))], { capEnd: true });
    const nozGeo = loft([nozRing(NOZ_START, nozR), nozRing(51.6, nozR - 0.02), nozRing(NOZ_END, nozR - 0.06), nozRing(NOZ_END, nozR - 0.1), nozRing(NOZ_END - 0.6, nozR - 0.12)], { capEnd: true });
    const mirrored = new Map([nacGeo, lipGeo, ductGeo, nozGeo].map((g) => [g, mirrorY(g)]));
    for (const side of [1, -1]) {
      const m = (g) => (side > 0 ? g : mirrored.get(g));
      airframe.add(
        makeMesh(m(nacGeo), mats.nacelle, null, 'nacelle'),
        makeMesh(m(lipGeo), mats.lip, null, 'intakeLip'),
        makeMesh(m(ductGeo), mats.duct, null, 'intakeDuct'),
        makeMesh(m(nozGeo), mats.nozzle, null, 'nozzle'),
      );
      // nozzle glow + reheat flame
      const exit = Tp([NOZ_END, side * yc, nozC]);
      const glowDisk = new THREE.Mesh(new THREE.CircleGeometry(nozR - 0.12, 24), mats.glow.clone());
      glowDisk.material.color.setHex(0xff5a14);
      glowDisk.rotation.y = -Math.PI / 2;
      glowDisk.position.copy(exit).add(new THREE.Vector3(0.55, 0, 0));
      airframe.add(glowDisk);
      glows.push(glowDisk);
      const flame = new THREE.Group();
      flame.position.copy(exit);
      for (const [r, len, col] of [[nozR - 0.1, 6.5, 0xff3c00], [nozR * 0.55, 3.4, 0xff7a18]]) {
        const cg = new THREE.ConeGeometry(r, len, 20, 1, true);
        cg.rotateZ(Math.PI / 2);
        cg.translate(-len / 2, 0, 0);
        const fm = mats.glow.clone();
        fm.color.setHex(col);
        fm.side = THREE.DoubleSide;
        flame.add(new THREE.Mesh(cg, fm));
      }
      flame.visible = false;
      airframe.add(flame);
      flames.push(flame);
    }
  }
  /* -------------------------------------- gear -------------------------------------- */
  const mainLegs = [];
  const MAIN_Y = 3.55;
  const MAIN_PIV_W = 3.72;
  const WR = 0.62;
  for (const side of [1, -1]) {
    const leg = new THREE.Group();
    leg.position.copy(Tp([S_MAIN, side * MAIN_Y, MAIN_PIV_W]));
    airframe.add(leg);
    const len = MAIN_PIV_W - WR;
    leg.add(strut(new THREE.Vector3(0, 0.1, 0), new THREE.Vector3(0, -1.55, 0), 0.17, mats.gear));
    // drag brace (fore-aft, so it stays inside the wing when the leg swings inboard)
    leg.add(strut(new THREE.Vector3(0, -1.3, 0), new THREE.Vector3(-1.1, 0.05, 0), 0.07, mats.gear, 8));
    const piston = new THREE.Group();
    leg.add(piston);
    piston.add(strut(new THREE.Vector3(0, -1.4, 0), new THREE.Vector3(0, -len + 0.05, 0), 0.115, mats.gear));
    // torque links
    piston.add(strut(new THREE.Vector3(0.05, -1.5, 0), new THREE.Vector3(0.3, -1.85, 0), 0.04, mats.gear, 6));
    piston.add(strut(new THREE.Vector3(0.3, -1.85, 0), new THREE.Vector3(0.05, -2.2, 0), 0.04, mats.gear, 6));
    const bogie = new THREE.Group();
    bogie.position.set(0, -len, 0);
    piston.add(bogie);
    bogie.add(strut(new THREE.Vector3(-0.78, 0, 0), new THREE.Vector3(0.78, 0, 0), 0.09, mats.gear, 10));
    for (const ax of [-0.7, 0.7]) {
      bogie.add(strut(new THREE.Vector3(ax, 0, -0.5), new THREE.Vector3(ax, 0, 0.5), 0.06, mats.gear, 8));
      for (const z of [-0.44, 0.44]) {
        const wh = wheel(WR, 0.32, mats);
        wh.position.set(ax, 0, z);
        bogie.add(wh);
      }
    }
    leg.userData = { side, piston, bogie };
    mainLegs.push(leg);
  }
  const NOSE_PIV_W = 3.6;
  const NWR = 0.45;
  const noseLeg = new THREE.Group();
  noseLeg.position.copy(Tp([S_NOSEGEAR, 0, NOSE_PIV_W]));
  airframe.add(noseLeg);
  {
    const len = NOSE_PIV_W - NWR;
    noseLeg.add(strut(new THREE.Vector3(0, 0.1, 0), new THREE.Vector3(0, -1.9, 0), 0.13, mats.gear));
    noseLeg.add(strut(new THREE.Vector3(0, -1.6, 0), new THREE.Vector3(0, -len, 0), 0.09, mats.gear));
    noseLeg.add(strut(new THREE.Vector3(0, -1.0, 0), new THREE.Vector3(1.1, 0.1, 0), 0.05, mats.gear, 8));
    noseLeg.add(strut(new THREE.Vector3(0, -len, -0.4), new THREE.Vector3(0, -len, 0.4), 0.05, mats.gear, 8));
    for (const z of [-0.3, 0.3]) {
      const wh = wheel(NWR, 0.28, mats);
      wh.position.set(0, -len, z);
      noseLeg.add(wh);
    }
  }

  /* ------------------------------------- state ------------------------------------- */
  let gearT = 1;
  let droop = 0;
  let visorT = 0;

  const ac = {
    id: 'concorde',
    name: 'Concorde',
    root,
    eye: [S_MAIN - 9.85, 5.72, -0.55],
    chaseDistance: 70,
    update(dt, s) {
      // landing gear (1 = down): legs swing inward / forward over ~5 s
      gearT = approach(gearT, s.gearDown ? 1 : 0, 1 / 5, dt);
      const up = 1 - gearT;
      const swing = sstep(0.1, 1, up);
      const shorten = sstep(0, 0.45, up);
      for (const leg of mainLegs) {
        const { side, piston, bogie } = leg.userData;
        leg.rotation.x = side * swing * 97 * DEG;
        piston.position.y = shorten * 0.12;
        bogie.rotation.z = (s.onGround && gearT > 0.99 ? 0 : 6 * DEG) + shorten * 4 * DEG;
      }
      noseLeg.rotation.z = sstep(0.1, 1, up) * 90 * DEG;

      // droop nose and visor
      let target = 0;
      if (s.gearDown && s.flaps === 'landing') target = 12.5;
      else if (s.gearDown || s.speed < 130) target = 5;
      // the visor lowers before the nose droops and rises only once the nose is back up
      if (target > 0) visorT = approach(visorT, 1, 0.8, dt);
      else if (droop < 0.01) visorT = approach(visorT, 0, 0.8, dt);
      droop = approach(droop, visorT > 0.95 ? target : 0, 3, dt);
      noseHinge.userData.set(-droop * DEG);
      visor.position.y = -0.42 * sstep(0, 1, visorT);

      // elevons: pitch + roll mixing (positive angle = trailing edge down)
      for (const h of elevons) {
        const tgt = clamp((-(s.pitch || 0) * 15 - h.userData.side * (s.roll || 0) * 12) * DEG, -25 * DEG, 25 * DEG);
        h.userData.angle = approach(h.userData.angle, tgt, 80 * DEG, dt);
        h.userData.set(h.userData.angle);
      }
      for (const h of rudders) {
        h.userData.angle = approach(h.userData.angle, clamp((s.yaw || 0) * 25 * DEG, -25 * DEG, 25 * DEG), 80 * DEG, dt);
        h.userData.set(h.userData.angle);
      }

      // engines
      const ab = clamp(s.afterburner || 0, 0, 1);
      const thr = clamp(s.throttle || 0, 0, 1);
      for (const g of glows) g.material.opacity = 0.08 + 0.3 * thr + 0.6 * ab;
      for (let i = 0; i < flames.length; i++) {
        const f = flames[i];
        f.visible = ab > 0.01;
        if (!f.visible) continue;
        const flick = 1 + 0.06 * Math.sin((s.time || 0) * 37 + i * 1.7) + 0.04 * Math.sin((s.time || 0) * 61 + i);
        f.scale.set((0.55 + 0.45 * ab) * flick, 0.85 + 0.15 * ab, 0.85 + 0.15 * ab);
        f.children[0].material.opacity = 0.4 * ab;
        f.children[1].material.opacity = 0.55 * ab;
      }
    },
  };
  ac.update(0, { gearDown: true, flaps: 'up', speed: 200, throttle: 0, afterburner: 0, pitch: 0, roll: 0, yaw: 0, onGround: true, time: 0 });
  visorT = 0;
  return ac;
}
