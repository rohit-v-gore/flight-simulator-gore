import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { loft, finalize, sectionRing, ellipseRing, nacaHalf, camberLine, Tp } from '../f22/geom.js';
import { curve, lerp, sstep, approach, clamp, DEG } from '../f22/util.js';

/*
 * Generic narrow-body twin-jet airliner (A320 / 737 class), fictional "SKYLINE" livery.
 *
 * Built in the shared design frame (s = metres aft of the nose tip, y = starboard, w = metres above the
 * ground with the gear down) and converted to scene axes (X = -s, Y = w, Z = y). The airframe group is
 * shifted so the main-gear contact point sits at the origin.
 */

const L = 37.6; // fuselage length
const S_MAIN = 18.0; // main gear axle station
const TAN5 = Math.tan(5 * DEG);

/* ------------------------------------------------------------------ helpers */

/** Make every triangle of a closed mesh face outward (positive signed volume). */
function autoOrient(geo) {
  const p = geo.attributes.position.array;
  const idx = geo.index.array;
  let vol = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    vol +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  if (vol < 0) {
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
    geo.computeVertexNormals();
  }
  return geo;
}

function shade(m, cast = true) {
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
}

/** Closed design-frame loft -> scene mesh (optionally relative to a design pivot), added to parent. */
function part(rings, mat, parent, pivot = null) {
  const geo = autoOrient(finalize(loft(rings, { capStart: true, capEnd: true }), pivot));
  const m = shade(new THREE.Mesh(geo, mat));
  parent.add(m);
  return m;
}

const mirror = (ring) => ring.map(([s, y, w]) => [s, -y, w]);
const lerp3 = (a, b, t) => a.map((v, j) => v + (b[j] - v) * t);

/** Hinge group at design point `pivot`; `a`,`b` design points on the hinge line. Axis oriented so that
 * `ref` (scene axis sign: 'z' or 'y') is positive. pose(angle, offset) sets rotation + translation. */
function hinge(parent, pivot, a, b, ref = 'z') {
  const g = new THREE.Group();
  const base = Tp(pivot);
  g.position.copy(base);
  const axis = Tp(b).sub(Tp(a)).normalize();
  if (axis[ref] < 0) axis.negate();
  g.userData.pose = (angle, dx = 0, dy = 0) => {
    g.quaternion.setFromAxisAngle(axis, angle);
    g.position.set(base.x + dx, base.y + dy, base.z);
  };
  parent.add(g);
  return g;
}

/** Surface of revolution about the scene X axis. profile = [[x, r], ...]. */
function revolve(profile, segs = 48) {
  const pos = [];
  const uv = [];
  const index = [];
  const n = profile.length;
  for (let i = 0; i < n; i++) {
    const [x, r] = profile[i];
    for (let k = 0; k <= segs; k++) {
      const a = (2 * Math.PI * k) / segs;
      pos.push(x, r * Math.cos(a), r * Math.sin(a));
      uv.push(k / segs, i / (n - 1));
    }
  }
  for (let i = 0; i + 1 < n; i++)
    for (let k = 0; k < segs; k++) {
      const a = i * (segs + 1) + k;
      const b = a + 1;
      const c = a + segs + 2;
      const d = a + segs + 1;
      index.push(a, d, b, b, d, c);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

/** Thin slab from four corner design points (quad p0..p3 in order), extruded `th` along -normal. */
function slab(corners, th, pivot) {
  const P = corners.map((c) => Tp(c).sub(Tp(pivot)));
  const n = new THREE.Vector3().subVectors(P[1], P[0]).cross(new THREE.Vector3().subVectors(P[3], P[0])).normalize();
  const Q = P.map((p) => p.clone().addScaledVector(n, -th));
  const v = [...P, ...Q];
  const faces = [
    [0, 1, 2, 3],
    [7, 6, 5, 4],
    [0, 4, 5, 1],
    [1, 5, 6, 2],
    [2, 6, 7, 3],
    [3, 7, 4, 0],
  ];
  const pos = [];
  for (const [a, b, c, d] of faces) for (const k of [a, b, c, a, c, d]) pos.push(v[k].x, v[k].y, v[k].z);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

function cyl(a, b, r, mat, r2 = r, seg = 14) {
  const span = new THREE.Vector3().subVectors(b, a);
  const m = shade(new THREE.Mesh(new THREE.CylinderGeometry(r2, r, span.length(), seg), mat));
  m.position.addVectors(a, b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), span.normalize());
  return m;
}

/* ------------------------------------------------------------------ fuselage shape */

const topW = curve([[0, 3.56], [0.35, 3.95], [1.1, 4.27], [1.9, 4.5], [2.5, 4.7], [3.1, 5.07], [3.9, 5.46], [4.9, 5.77], [6.0, 5.92], [7.0, 5.95], [24, 5.95], [29, 5.83], [33, 5.56], [36, 5.22], [L, 5.02]]);
const botW = curve([[0, 3.56], [0.35, 3.16], [1.1, 2.74], [2.1, 2.36], [3.5, 2.06], [5, 1.92], [6.5, 1.86], [7.5, 1.85], [22.5, 1.85], [25, 1.98], [28, 2.55], [31, 3.3], [34, 4.08], [L, 4.62]]);
const halfW = curve([[0, 0], [0.12, 0.3], [0.35, 0.6], [1.1, 1.08], [2.1, 1.47], [3.5, 1.78], [5, 1.93], [6.5, 1.975], [24, 1.975], [27, 1.86], [30, 1.56], [33, 1.1], [36, 0.56], [L, 0.3]]);
const R_ARC = 2.0;
// windscreen panes: corners given as (s, 'y', span) on the crown or (s, 'w', height) on the sides,
// converted to (s, angle above the waist in degrees) for painting
const WINDSCREEN = [
  [[2.45, 'y', 0.07], [2.64, 'y', 0.93], [3.36, 'y', 0.82], [3.18, 'y', 0.07]],
  [[3.52, 'w', 4.42], [4.32, 'w', 4.42], [4.28, 'w', 5.0], [3.48, 'w', 5.08]],
  [[4.47, 'w', 4.43], [5.06, 'w', 4.45], [5.04, 'w', 4.96], [4.47, 'w', 4.99]],
].map((poly) =>
  poly.map(([s, k, v]) => {
    const t = topW(s);
    const b = botW(s);
    const a = k === 'y' ? Math.acos(clamp(v / halfW(s), 0, 1)) : Math.asin(clamp((v - (t + b) / 2) / ((t - b) / 2), -1, 1));
    return [s, a / DEG];
  }),
); // nominal radius used to lay the livery out in metres

function fuselageSamples() {
  const s = [];
  for (let i = 0; i <= 30; i++) s.push(7 * (i / 30) ** 1.7);
  for (let i = 1; i <= 12; i++) s.push(7 + (17 * i) / 12);
  for (let i = 1; i <= 26; i++) s.push(24 + (13.6 * i) / 26);
  return s;
}

/** Tube with a duplicated seam (for UVs). v runs bottom -> starboard -> top -> port -> bottom. */
function fuselageTube(sList, N, { scale = 1, uSpan = L } = {}) {
  const pos = [];
  const uv = [];
  const index = [];
  for (const s of sList) {
    const t = topW(s);
    const b = botW(s);
    const c = (t + b) / 2;
    const r = ((t - b) / 2) * scale;
    const h = halfW(s) * scale;
    for (let i = 0; i <= N; i++) {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / N;
      const y = h * Math.cos(a);
      const w = c + r * Math.sin(a);
      pos.push(-s, w, y);
      uv.push(s / uSpan, i / N);
    }
  }
  const rowN = N + 1;
  for (let j = 0; j + 1 < sList.length; j++)
    for (let i = 0; i < N; i++) {
      const a = j * rowN + i;
      const b = a + 1;
      const c = a + rowN + 1;
      const d = a + rowN;
      index.push(a, b, c, a, c, d);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  autoOrient(geo);
  geo.computeVertexNormals();
  // weld normals across the seam
  const nrm = geo.attributes.normal;
  for (let j = 0; j < sList.length; j++) {
    const a = j * rowN;
    const b = a + N;
    const v = new THREE.Vector3().fromBufferAttribute(nrm, a).add(new THREE.Vector3().fromBufferAttribute(nrm, b)).normalize();
    nrm.setXYZ(a, v.x, v.y, v.z);
    nrm.setXYZ(b, v.x, v.y, v.z);
  }
  return geo;
}

/* ------------------------------------------------------------------ livery textures */

const BLUE = '#14357a';
const GOLD = '#f0a818';
const BELLY = '#a7adb5';



function fuselageTexture(renderer) {
  const W = 4096;
  const H = 1536;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  const kx = W / L;
  const ky = H / (2 * Math.PI * R_ARC);
  const h = (deg) => R_ARC * deg * DEG; // arc metres above the waist
  g.fillStyle = '#f4f5f6';
  g.fillRect(0, 0, W, H);

  for (const side of [1, -1]) {
    // local frame: units of cm, x = viewer right, y = viewer down
    if (side > 0) g.setTransform(-kx / 100, 0, 0, -ky / 100, 0, 0.25 * H);
    else g.setTransform(kx / 100, 0, 0, ky / 100, 0, 0.75 * H);
    const X = (s) => (side > 0 ? -s : s) * 100;
    const Y = (m) => -m * 100;
    const rect = (s0, s1, h0, h1, fill, rad = 0) => {
      const x0 = Math.min(X(s0), X(s1));
      const y0 = Math.min(Y(h0), Y(h1));
      g.beginPath();
      g.roundRect(x0, y0, Math.abs(X(s1) - X(s0)), Math.abs(Y(h1) - Y(h0)), rad);
      g.fillStyle = fill;
      g.fill();
    };
    const outline = (s0, s1, h0, h1, rad, color = '#7d858e', lw = 2.5) => {
      const x0 = Math.min(X(s0), X(s1));
      const y0 = Math.min(Y(h0), Y(h1));
      g.beginPath();
      g.roundRect(x0, y0, Math.abs(X(s1) - X(s0)), Math.abs(Y(h1) - Y(h0)), rad);
      g.strokeStyle = color;
      g.lineWidth = lw;
      g.stroke();
    };
    // belly and cheatlines
    // belly boundary sweeps down under the nose so the cheatlines don't wrap around the radome
    const bnd = (s) => -30 - 66 * (1 - sstep(1.6, 7.5, s));
    const band = (o0, o1, fill) => {
      g.beginPath();
      const pts = [];
      for (let s = 0; s <= L + 1; s += 0.25) pts.push(s);
      pts.forEach((s, i) => (i ? g.lineTo(X(s), Y(h(Math.max(-96, bnd(s) + o1)))) : g.moveTo(X(s), Y(h(Math.max(-96, bnd(s) + o1))))));
      for (let i = pts.length - 1; i >= 0; i--) g.lineTo(X(pts[i]), Y(h(Math.max(-96, bnd(pts[i]) + o0))));
      g.closePath();
      g.fillStyle = fill;
      g.fill();
    };
    band(-80, 0, BELLY);
    band(0, 3.5, BLUE);
    band(4.4, 5.6, GOLD);
    // blue tail sweep up the aft fuselage
    g.beginPath();
    g.moveTo(X(27.5), Y(h(-26.5)));
    g.bezierCurveTo(X(31), Y(h(-24)), X(33.5), Y(h(30)), X(35.2), Y(h(100)));
    g.lineTo(X(L + 1), Y(h(100)));
    g.lineTo(X(L + 1), Y(h(-26.5)));
    g.closePath();
    g.fillStyle = BLUE;
    g.fill();
    g.beginPath();
    g.moveTo(X(27.0), Y(h(-24.4)));
    g.bezierCurveTo(X(30.6), Y(h(-22)), X(33.1), Y(h(32)), X(34.7), Y(h(100)));
    g.lineTo(X(35.2), Y(h(100)));
    g.bezierCurveTo(X(33.5), Y(h(30)), X(31), Y(h(-24)), X(27.5), Y(h(-26.5)));
    g.closePath();
    g.fillStyle = GOLD;
    g.fill();
    // radome seam
    g.strokeStyle = '#b8bec5';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(X(1.3), Y(h(-95)));
    g.lineTo(X(1.3), Y(h(95)));
    g.stroke();

    // cabin windows
    const doors = [
      [5.7, 6.55],
      [15.15, 15.75],
      [16.05, 16.65],
      [30.95, 31.8],
    ];
    const blocked = (s) => doors.some(([a, b]) => s > a - 0.25 && s < b + 0.25);
    const wc = h(12);
    for (let s = 7.3; s < 30.6; s += 0.53) {
      if (blocked(s)) continue;
      rect(s - 0.15, s + 0.15, wc - 0.21, wc + 0.21, '#c3c9d0', 9);
      rect(s - 0.115, s + 0.115, wc - 0.17, wc + 0.17, '#1a2129', 8);
    }
    // doors (passenger + overwing exits) and cargo doors
    outline(5.7, 6.55, h(-22), h(31), 14);
    outline(30.95, 31.8, h(-22), h(31), 14);
    outline(15.15, 15.75, h(0), h(27), 10);
    outline(16.05, 16.65, h(0), h(27), 10);
    for (const [s0] of [[5.7], [30.95]]) rect(s0 + 0.62, s0 + 0.75, h(4), h(6), '#7d858e', 2);
    if (side > 0) {
      outline(8.6, 10.4, h(-58), h(-33), 8);
      outline(24.6, 26.4, h(-58), h(-33), 8);
    }
    // windscreen
    for (const poly of WINDSCREEN) {
      g.beginPath();
      poly.forEach(([s, a], i) => (i ? g.lineTo(X(s), Y(h(a))) : g.moveTo(X(s), Y(h(a)))));
      g.closePath();
      g.fillStyle = '#10161d';
      g.fill();
      g.strokeStyle = '#59616b';
      g.lineWidth = 5;
      g.stroke();
    }
    // titles
    g.fillStyle = BLUE;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.font = 'italic 900 132px "Arial Black", Arial, sans-serif';
    g.save();
    g.translate(X(13.2), Y(h(28)));
    g.scale(1.15, 1);
    g.fillText('SKYLINE', 0, 0);
    g.restore();
    g.font = 'bold 26px Arial, sans-serif';
    g.fillStyle = '#3b4655';
    g.fillText('SX-KYL', X(29.2), Y(h(-15)));
    g.font = 'italic bold 22px Arial, sans-serif';
    g.fillText('Spirit of the Horizon', X(4.6), Y(h(-12)));
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.anisotropy = renderer?.capabilities?.getMaxAnisotropy?.() || 4;
  return tex;
}

/** Alpha mask for the cockpit interior shell: holes where the windscreen is. Covers s = 0..7. */
function cockpitMask() {
  const W = 1024;
  const H = 1024;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#000';
  for (const side of [1, -1])
    for (const poly of WINDSCREEN) {
      g.beginPath();
      poly.forEach(([s, a], i) => {
        const x = (s / 7) * W;
        const y = (side > 0 ? 0.25 + a / 360 : 0.75 - a / 360) * H;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.closePath();
      g.fill();
    }
  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false;
  return tex;
}

function finTexture() {
  const S = 1024;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = BLUE;
  g.fillRect(0, 0, S, S);
  const cx = S / 2;
  const cy = S * 0.5;
  // rising sun over a horizon: gold disc with white swooshes (symmetric so both sides read)
  const grad = g.createRadialGradient(cx, cy - 40, 30, cx, cy, 300);
  grad.addColorStop(0, '#ffd45a');
  grad.addColorStop(1, GOLD);
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx, cy, 280, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = BLUE;
  for (let k = 0; k < 3; k++) {
    const yy = cy + 60 + k * 70;
    g.fillRect(cx - 300, yy, 600, 26 + k * 6);
  }
  g.strokeStyle = '#ffffff';
  g.lineWidth = 34;
  g.beginPath();
  g.arc(cx, cy + 520, 760, Math.PI * 1.3, Math.PI * 1.7);
  g.stroke();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

function spinnerTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = '#2b2f35';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#f2f2f2';
  g.lineWidth = 9;
  g.beginPath();
  g.moveTo(0, 128);
  g.bezierCurveTo(30, 90, 50, 40, 64, 0);
  g.stroke();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function glowTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}

/* ------------------------------------------------------------------ lifting surfaces */

/** Main wing station (starboard) at span y. */
function wingStation(y) {
  const le = 12.3 + 0.51 * y;
  const te = y <= 6.3 ? 19.6 : lerp(19.6, 22.47, (y - 6.3) / 10.7);
  const w = 2.42 + y * TAN5;
  const t = y < 2 ? lerp(0.155, 0.15, y / 2) : y < 6.3 ? lerp(0.15, 0.125, (y - 2) / 4.3) : lerp(0.125, 0.105, (y - 6.3) / 10.7);
  return { le: [le, y, w], te: [te, y, w], up: [0, -Math.sin(5 * DEG), Math.cos(5 * DEG)], t, m: 0.018 };
}

const chordPt = (f, x) => lerp3(f.le, f.te, x);
const surfPt = (f, x, off = 0) => {
  const c = Math.hypot(f.te[0] - f.le[0], f.te[1] - f.le[1], f.te[2] - f.le[2]);
  const d = (camberLine(x, f.m || 0) + nacaHalf(x, f.t)) * c + off;
  return chordPt(f, x).map((v, j) => v + f.up[j] * d);
};

function wingRings(ya, yb, x0, x1, n, side, stationFn = wingStation, breaks = [2, 6.3]) {
  const ys = [ya, ...breaks.filter((v) => v > ya + 1e-6 && v < yb - 1e-6), yb];
  return ys.map((y) => {
    const r = sectionRing(stationFn(y), x0, x1, n);
    return side > 0 ? r : mirror(r);
  });
}

const sd = (p, side) => (side > 0 ? p : [p[0], -p[1], p[2]]);

/* ------------------------------------------------------------------ build */

export function create(renderer) {
  const root = new THREE.Group();
  root.name = 'airliner';
  const air = new THREE.Group();
  air.position.x = S_MAIN;
  root.add(air);

  /* materials */
  const fuseTex = fuselageTexture(renderer);
  const M = {
    fuse: new THREE.MeshStandardMaterial({ map: fuseTex, roughness: 0.38, metalness: 0.05 }),
    belly: new THREE.MeshStandardMaterial({ color: BELLY, roughness: 0.45, metalness: 0.1 }),
    wing: new THREE.MeshStandardMaterial({ color: 0xc4c9cf, roughness: 0.45, metalness: 0.25 }),
    wingDark: new THREE.MeshStandardMaterial({ color: 0xaeb4bb, roughness: 0.5, metalness: 0.25 }),
    fin: new THREE.MeshStandardMaterial({ map: finTexture(), roughness: 0.35, metalness: 0.05 }),
    blue: new THREE.MeshStandardMaterial({ color: BLUE, roughness: 0.35, metalness: 0.1, side: THREE.DoubleSide }),
    lip: new THREE.MeshStandardMaterial({ color: 0xd9dde2, roughness: 0.18, metalness: 0.9, side: THREE.DoubleSide }),
    duct: new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.7, metalness: 0.3, side: THREE.DoubleSide }),
    core: new THREE.MeshStandardMaterial({ color: 0x8c9198, roughness: 0.4, metalness: 0.7, side: THREE.DoubleSide }),
    exhaust: new THREE.MeshStandardMaterial({ color: 0x4a4744, roughness: 0.6, metalness: 0.6, side: THREE.DoubleSide }),
    blade: new THREE.MeshStandardMaterial({ color: 0x9aa1a9, roughness: 0.3, metalness: 0.9, side: THREE.DoubleSide }),
    spinner: new THREE.MeshStandardMaterial({ map: spinnerTexture(), roughness: 0.35, metalness: 0.4 }),
    pylon: new THREE.MeshStandardMaterial({ color: 0xdfe2e6, roughness: 0.4, metalness: 0.1 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.9 }),
    hub: new THREE.MeshStandardMaterial({ color: 0xb8bcc0, roughness: 0.35, metalness: 0.8 }),
    strut: new THREE.MeshStandardMaterial({ color: 0xd8dadc, roughness: 0.35, metalness: 0.6 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xf0f2f4, roughness: 0.12, metalness: 1.0 }),
    door: new THREE.MeshStandardMaterial({ color: BELLY, roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide }),
    whiteDoor: new THREE.MeshStandardMaterial({ color: 0xeceeef, roughness: 0.4, metalness: 0.05, side: THREE.DoubleSide }),
    interior: new THREE.MeshStandardMaterial({ color: 0x3b4048, roughness: 0.85, side: THREE.BackSide, alphaMap: cockpitMask(), alphaTest: 0.5 }),
    panel: new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.8 }),
    screen: new THREE.MeshBasicMaterial({ color: 0x1d4a7a }),
    apu: new THREE.MeshStandardMaterial({ color: 0x2a2826, roughness: 0.8, metalness: 0.4, side: THREE.DoubleSide }),
  };

  /* fuselage */
  const fuseGeo = fuselageTube(fuselageSamples(), 72);
  const fuse = shade(new THREE.Mesh(fuseGeo, M.fuse));
  fuse.name = 'fuselage';
  air.add(fuse);
  // tail-cone end (APU exhaust)
  {
    const c = (topW(L) + botW(L)) / 2;
    const ring = ellipseRing(L, 0, c, halfW(L), (topW(L) - botW(L)) / 2, (topW(L) - botW(L)) / 2, 2, 24);
    const inner = ellipseRing(L + 0.02, 0, c, halfW(L) * 0.75, (topW(L) - botW(L)) * 0.36, (topW(L) - botW(L)) * 0.36, 2, 24);
    const deep = ellipseRing(L - 0.2, 0, c, halfW(L) * 0.55, (topW(L) - botW(L)) * 0.26, (topW(L) - botW(L)) * 0.26, 2, 24);
    const geo = finalize(loft([ring, inner, deep], { capEnd: true }));
    air.add(shade(new THREE.Mesh(geo, M.apu)));
  }
  // belly / wing-root fairing
  {
    const ry = curve([[10.2, 1.3], [12.4, 2.2], [14, 2.42], [19.5, 2.42], [21.6, 2.05], [23.4, 1.2]]);
    const bot = curve([[10.2, 1.86], [12.4, 1.68], [14, 1.63], [20, 1.63], [22, 1.7], [23.4, 1.87]]);
    const rings = [];
    for (let i = 0; i <= 26; i++) {
      const s = 10.2 + (13.2 * i) / 26;
      const c = 2.95;
      rings.push(ellipseRing(s, 0, c, ry(s), 0.85, c - bot(s), 3.2, 48));
    }
    part(rings, M.belly, air).name = 'fairing';
  }
  // cockpit interior shell, panel and glareshield (seen from the cockpit camera)
  {
    const sl = [];
    for (let i = 0; i <= 28; i++) sl.push(6.8 * (i / 28) ** 1.3);
    const shell = new THREE.Mesh(fuselageTube(sl, 72, { scale: 0.975, uSpan: 7 }), M.interior);
    shell.receiveShadow = true;
    air.add(shell);
    const box = (s0, s1, y0, y1, w0, w1, mat) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(s1 - s0, w1 - w0, y1 - y0), mat);
      m.position.set(-(s0 + s1) / 2, (w0 + w1) / 2, (y0 + y1) / 2);
      air.add(m);
      return m;
    };
    box(2.62, 3.05, -1.0, 1.0, 3.55, 4.38, M.panel);
    box(2.78, 3.28, -0.92, 0.92, 4.38, 4.45, M.panel);
    box(3.05, 4.3, -0.22, 0.22, 3.55, 4.0, M.panel);
    for (const y of [-0.82, -0.46, 0.46, 0.82]) {
      const d = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.26), M.screen);
      d.position.set(-3.06, 4.15, y);
      d.rotation.y = -Math.PI / 2;
      air.add(d);
    }
  }

  /* ---------------- wings ---------------- */
  const ctl = { flaps: [], slats: [], ail: [], spoil: [], elev: [], rudder: null };
  const SLATS = [[2.3, 5.3], [6.2, 8.8], [8.8, 11.4], [11.4, 14.0], [14.0, 16.6]];
  const FLAPS = [[2.45, 6.3], [6.3, 12.6]];
  const AIL = [12.6, 16.3];
  const SPOILERS = [];
  for (let k = 0; k < 5; k++) SPOILERS.push([6.45 + k * 1.21, 6.45 + (k + 1) * 1.21 - 0.04]);
  const X_SLAT = 0.14;
  const X_TE = 0.75;

  for (const side of [1, -1]) {
    // fixed box: split spanwise where the movable surfaces change
    const cuts = [1.2, 17.0];
    for (const [a, b] of [...SLATS, ...FLAPS, AIL]) cuts.push(a, b);
    const ys = [...new Set(cuts.map((v) => +v.toFixed(3)))].sort((a, b) => a - b);
    for (let i = 0; i + 1 < ys.length; i++) {
      const ya = ys[i];
      const yb = ys[i + 1];
      const ym = (ya + yb) / 2;
      const hasSlat = SLATS.some(([a, b]) => ym > a && ym < b);
      const hasTE = [...FLAPS, AIL].some(([a, b]) => ym > a && ym < b);
      part(wingRings(ya, yb, hasSlat ? X_SLAT : 0, hasTE ? X_TE : 1, 16, side), M.wing, air);
    }
    // sharklet: blend from the tip station up into a near-vertical, swept winglet
    {
      const tip = wingStation(17.0);
      const WL = [
        [17.0, 0, 20.97, 1.5, 5, 0.105],
        [17.32, 0.1, 21.2, 1.32, 28, 0.1],
        [17.56, 0.38, 21.48, 1.12, 60, 0.095],
        [17.7, 0.82, 21.8, 0.96, 80, 0.09],
        [17.85, 1.6, 22.35, 0.72, 86, 0.09],
        [17.91, 2.35, 22.95, 0.45, 87, 0.09],
      ];
      const rings = WL.map(([y, dw, le, c, phi, t]) => {
        const w = tip.le[2] + dw;
        const f = { le: [le, y, w], te: [le + c, y, w], up: [0, -Math.sin(phi * DEG), Math.cos(phi * DEG)], t, m: 0.01 };
        const r = sectionRing(f, 0, 1, 16);
        return side > 0 ? r : mirror(r);
      });
      part(rings, M.wing, air).name = 'winglet';
    }
    // slats
    for (const [ya, yb] of SLATS) {
      const fa = wingStation(ya);
      const fb = wingStation(yb);
      const pa = sd(chordPt(fa, X_SLAT), side);
      const pb = sd(chordPt(fb, X_SLAT), side);
      const pv = lerp3(pa, pb, 0.5);
      const hg = hinge(air, pv, pa, pb);
      part(wingRings(ya, yb, 0, X_SLAT, 10, side), M.wing, hg, pv);
      ctl.slats.push(hg);
    }
    // flaps
    for (const [ya, yb] of FLAPS) {
      const pa = sd(chordPt(wingStation(ya), X_TE), side);
      const pb = sd(chordPt(wingStation(yb), X_TE), side);
      const pv = lerp3(pa, pb, 0.5);
      const hg = hinge(air, pv, pa, pb);
      hg.userData.chord = wingStation((ya + yb) / 2).te[0] - wingStation((ya + yb) / 2).le[0];
      part(wingRings(ya, yb, X_TE, 1, 12, side), M.wingDark, hg, pv);
      ctl.flaps.push(hg);
    }
    // aileron
    {
      const [ya, yb] = AIL;
      const pa = sd(chordPt(wingStation(ya), X_TE), side);
      const pb = sd(chordPt(wingStation(yb), X_TE), side);
      const pv = lerp3(pa, pb, 0.5);
      const hg = hinge(air, pv, pa, pb);
      hg.userData.side = side;
      part(wingRings(ya, yb, X_TE, 1, 12, side), M.wingDark, hg, pv);
      ctl.ail.push(hg);
    }
    // spoilers: thin panels on the upper surface ahead of the flaps
    for (const [ya, yb] of SPOILERS) {
      const xs = [0.585, 0.62, 0.66, 0.7, 0.745];
      const ring = (y) => {
        const f = wingStation(y);
        const up = xs.map((x) => surfPt(f, x, 0.035));
        const lo = xs.slice().reverse().map((x) => surfPt(f, x, 0.004));
        const r = [...up, ...lo];
        return side > 0 ? r : mirror(r);
      };
      const pa = sd(surfPt(wingStation(ya), 0.585, 0.02), side);
      const pb = sd(surfPt(wingStation(yb), 0.585, 0.02), side);
      const pv = lerp3(pa, pb, 0.5);
      const hg = hinge(air, pv, pa, pb);
      hg.userData.side = side;
      part([ring(ya), ring(yb)], M.wing, hg, pv);
      ctl.spoil.push(hg);
    }
    // flap-track canoe fairings
    for (const y of [7.7, 10.2, 12.55]) {
      const f = wingStation(y);
      const c = f.te[0] - f.le[0];
      const s0 = f.le[0] + 0.45 * c;
      const s1 = f.te[0] + 1.1;
      const wl = f.le[2] - 0.04 * c;
      const rings = [];
      for (let i = 0; i <= 10; i++) {
        const u = i / 10;
        const s = lerp(s0, s1, u);
        const k = Math.sin(Math.PI * Math.min(1, u * 1.6 + 0.02) ** 0.8 * 0.5 + (u > 0.6 ? 0 : 0)) * (1 - sstep(0.75, 1, u) * 0.85);
        const r = ellipseRing(s, y, wl - 0.02 - 0.1 * k * Math.min(1, u * 3), 0.17 * k + 0.02, 0.12, 0.3 * k + 0.02, 2, 14);
        rings.push(side > 0 ? r : mirror(r));
      }
      part(rings, M.wing, air);
    }
  }

  /* ---------------- engines ---------------- */
  const fans = [];
  const ENG = { s: 11.25, y: 5.75, w: 1.72 };
  const bladeGeo = (() => {
    const nb = 22;
    const geos = [];
    for (let i = 0; i < nb; i++) {
      const phi = (2 * Math.PI * i) / nb;
      const pos = [];
      const index = [];
      const n = 8;
      for (let j = 0; j <= n; j++) {
        const u = j / n;
        const r = lerp(0.3, 0.965, u);
        const beta = lerp(58, 30, u) * DEG;
        const c = lerp(0.24, 0.36, u);
        const rad = [0, Math.cos(phi), Math.sin(phi)];
        const tan = [0, -Math.sin(phi), Math.cos(phi)];
        for (const e of [-0.5, 0.5]) {
          const d = [-Math.sin(beta) * c * e, ...[1, 2].map((k) => tan[k] * Math.cos(beta) * c * e)];
          pos.push(d[0] + e * 0.03 * u, rad[1] * r + d[1], rad[2] * r + d[2]);
        }
      }
      for (let j = 0; j < n; j++) {
        const a = 2 * j;
        index.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(index);
      g.computeVertexNormals();
      geos.push(g);
    }
    return mergeGeometries(geos);
  })();
  const lipGeo = revolve([[-0.32, 1.035], [-0.12, 1.06], [-0.03, 1.1], [0, 1.135], [-0.04, 1.185], [-0.14, 1.215], [-0.32, 1.235]], 56);
  const cowlGeo = revolve([[-0.32, 1.235], [-0.9, 1.26], [-1.9, 1.262], [-2.6, 1.21], [-3.15, 1.1], [-3.42, 1.0], [-3.4, 0.95], [-2.9, 0.975]], 56);
  const ductGeo = revolve([[-0.32, 1.035], [-0.7, 1.005], [-1.2, 0.99], [-2.9, 0.975]], 48);
  const coreGeo = revolve([[-1.1, 0.95], [-2.5, 0.9], [-3.3, 0.86], [-4.0, 0.74], [-4.5, 0.62], [-4.56, 0.58], [-4.5, 0.53]], 40);
  const plugGeo = revolve([[-4.3, 0.52], [-4.7, 0.42], [-5.1, 0.22], [-5.32, 0.04], [-5.34, 0]], 32);
  const spinGeo = revolve([[-0.45, 0], [-0.5, 0.1], [-0.62, 0.21], [-0.8, 0.3], [-0.98, 0.34], [-1.0, 0.34]], 32);
  const discGeo = new THREE.CircleGeometry(0.98, 40).rotateY(Math.PI / 2);

  for (const side of [1, -1]) {
    const eng = new THREE.Group();
    eng.position.copy(Tp([ENG.s, ENG.y * side, ENG.w]));
    air.add(eng);
    eng.add(shade(new THREE.Mesh(lipGeo, M.lip)));
    eng.add(shade(new THREE.Mesh(cowlGeo, M.blue)));
    eng.add(shade(new THREE.Mesh(ductGeo, M.duct)));
    eng.add(shade(new THREE.Mesh(coreGeo, M.core)));
    eng.add(shade(new THREE.Mesh(plugGeo, M.exhaust)));
    const disc = new THREE.Mesh(discGeo, M.duct);
    disc.position.x = -1.2;
    eng.add(disc);
    const fan = new THREE.Group();
    fan.position.x = -0.98;
    fan.add(shade(new THREE.Mesh(bladeGeo, M.blade), false));
    const sp = shade(new THREE.Mesh(spinGeo, M.spinner), false);
    sp.position.x = 0.98;
    fan.add(sp);
    eng.add(fan);
    fans.push(fan);
    // pylon
    const ring = (s0, s1, w, t) => {
      const r = sectionRing({ le: [s0, ENG.y, w], te: [s1, ENG.y, w], up: [0, 1, 0], t, m: 0 }, 0, 1, 12);
      return side > 0 ? r.map((p) => [p[0], p[1], p[2]]) : mirror(r);
    };
    part([ring(12.1, 18.6, 2.5, 0.055), ring(12.6, 17.4, 2.86, 0.07), ring(13.1, 16.0, 3.12, 0.12)], M.pylon, air).name = 'pylon';
  }

  /* ---------------- horizontal tail ---------------- */
  const stabStation = (y) => {
    const le = 31.55 + (y - 0.4) * Math.tan(30 * DEG);
    const c = lerp(4.0, 1.35, (y - 0.4) / 5.82);
    const w = 4.62 + (y - 0.4) * Math.tan(6 * DEG);
    return { le: [le, y, w], te: [le + c, y, w], up: [0, -Math.sin(6 * DEG), Math.cos(6 * DEG)], t: 0.11, m: 0 };
  };
  const X_ELEV = 0.7;
  for (const side of [1, -1]) {
    part(wingRings(0.4, 1.0, 0, 1, 14, side, stabStation, []), M.wing, air);
    part(wingRings(1.0, 6.22, 0, X_ELEV, 14, side, stabStation, []), M.wing, air);
    const pa = sd(chordPt(stabStation(1.0), X_ELEV), side);
    const pb = sd(chordPt(stabStation(6.1), X_ELEV), side);
    const pv = lerp3(pa, pb, 0.5);
    const hg = hinge(air, pv, pa, pb);
    part(wingRings(1.0, 6.1, X_ELEV, 1, 10, side, stabStation, []), M.wingDark, hg, pv);
    ctl.elev.push(hg);
  }

  /* ---------------- vertical tail ---------------- */
  const finStation = (w) => {
    const u = (w - 5.85) / (11.8 - 5.85);
    const le = 29.4 + (w - 5.85) * Math.tan(35 * DEG);
    const c = lerp(5.9, 2.0, u);
    return { le: [le, 0, w], te: [le + c, 0, w], up: [0, 1, 0], t: 0.11, m: 0 };
  };
  const finRings = (wa, wb, x0, x1, n) => [finStation(wa), finStation(wb)].map((f) => sectionRing(f, x0, x1, n));
  const finUV = (mesh) => {
    const ref = mesh.geometry.attributes.aRef;
    const uv = new Float32Array(ref.count * 2);
    for (let i = 0; i < ref.count; i++) {
      uv[2 * i] = (ref.getX(i) - 30.7) / 5.2;
      uv[2 * i + 1] = (ref.getZ(i) - 6.3) / 5.2;
    }
    mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  };
  const X_RUD = 0.7;
  finUV(part(finRings(5.0, 5.6, 0, 1, 18), M.fin, air));
  finUV(part(finRings(5.6, 11.8, 0, X_RUD, 18), M.fin, air));
  // dorsal fillet
  {
    const rings = [];
    for (let i = 0; i <= 6; i++) {
      const u = i / 6;
      const w = lerp(5.5, 6.75, u);
      const f = finStation(w);
      const le = lerp(26.4, f.le[0] + 0.1, u ** 0.6);
      rings.push(sectionRing({ le: [le, 0, w], te: [31.5, 0, w], up: [0, 1, 0], t: lerp(0.08, 0.1, u), m: 0 }, 0, 1, 12));
    }
    finUV(part(rings, M.fin, air));
  }
  {
    const pa = chordPt(finStation(5.6), X_RUD);
    const pb = chordPt(finStation(11.75), X_RUD);
    const pv = lerp3(pa, pb, 0.5);
    const hg = hinge(air, pv, pa, pb, 'y');
    const m = part(finRings(5.6, 11.75, X_RUD, 1, 10), M.fin, hg, pv);
    finUV(m);
    ctl.rudder = hg;
  }

  /* ---------------- landing gear ---------------- */
  const tyreGeo = (R, Wd) => {
    const pts = [[0.55, -0.48], [0.78, -0.5], [0.93, -0.44], [0.99, -0.28], [1.0, 0], [0.99, 0.28], [0.93, 0.44], [0.78, 0.5], [0.55, 0.48]].map(
      ([r, y]) => new THREE.Vector2(r * R, y * Wd),
    );
    return new THREE.LatheGeometry(pts, 36).rotateX(Math.PI / 2);
  };
  const wheel = (R, Wd) => {
    const g = new THREE.Group();
    g.add(shade(new THREE.Mesh(tyreGeo(R, Wd), M.rubber)));
    const hub = shade(new THREE.Mesh(new THREE.CylinderGeometry(R * 0.56, R * 0.56, Wd * 0.9, 24).rotateX(Math.PI / 2), M.hub));
    g.add(hub);
    return g;
  };
  const wheels = [];
  const gear = { main: [], mainDoors: [], nose: null, noseDoors: [], steer: null };

  // main gear: pivot in the wing root, retracts inboard into the belly
  const MAIN_R = 0.57;
  for (const side of [1, -1]) {
    const pivot = [S_MAIN, 3.3 * side, 2.5];
    const leg = new THREE.Group();
    leg.position.copy(Tp(pivot));
    air.add(leg);
    const len = 2.5 - MAIN_R;
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    leg.add(cyl(V(0, 0.1, 0), V(0, -1.25, 0), 0.14, M.strut, 0.13));
    leg.add(cyl(V(0, -1.2, 0), V(0, -len - 0.05, 0), 0.095, M.chrome));
    leg.add(cyl(V(0, -len, -0.5), V(0, -len, 0.5), 0.075, M.strut));
    leg.add(cyl(V(0, -0.5, 0), V(0, 0.15, -side * 1.05), 0.05, M.strut)); // side brace
    leg.add(cyl(V(0.05, -1.25, 0), V(0.18, -1.6, 0), 0.03, M.strut)); // torque link
    leg.add(cyl(V(0.18, -1.6, 0), V(0.04, -1.9, 0), 0.03, M.strut));
    for (const dz of [-0.43, 0.43]) {
      const wl = wheel(MAIN_R, 0.42);
      wl.position.set(0, -len, dz);
      leg.add(wl);
      wheels.push({ g: wl, r: MAIN_R });
    }
    // leg door on the outboard face of the strut
    const ld = new THREE.Mesh(new THREE.BoxGeometry(0.72, 1.15, 0.025), M.door);
    ld.position.set(0.02, -0.68, side * 0.2);
    leg.add(shade(ld));
    gear.main.push({ leg, side });
    // belly door hinged near the keel
    const s0 = S_MAIN - 0.85;
    const s1 = S_MAIN + 0.75;
    const yi = 0.22 * side;
    const yo = 1.15 * side;
    const pv = [S_MAIN, yi, 1.625];
    const hg = new THREE.Group();
    hg.position.copy(Tp(pv));
    air.add(hg);
    const dg = slab([[s0, yi, 1.625], [s1, yi, 1.625], [s1, yo, 1.632], [s0, yo, 1.632]], 0.03, pv);
    hg.add(shade(new THREE.Mesh(dg, M.door)));
    gear.mainDoors.push({ hg, side });
  }

  // nose gear: pivot under the cockpit floor, retracts forward
  {
    const NR = 0.39;
    const pivot = [5.4, 0, 2.55];
    const leg = new THREE.Group();
    leg.position.copy(Tp(pivot));
    air.add(leg);
    const len = 2.55 - NR;
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    leg.add(cyl(V(0, 0.1, 0), V(0, -1.3, 0), 0.11, M.strut, 0.1));
    const steer = new THREE.Group();
    leg.add(steer);
    steer.add(cyl(V(0, -1.25, 0), V(0, -len, 0), 0.075, M.chrome));
    steer.add(cyl(V(0, -len, -0.3), V(0, -len, 0.3), 0.05, M.strut));
    steer.add(cyl(V(0.0, -1.35, 0), V(0.16, -1.65, 0), 0.025, M.strut));
    steer.add(cyl(V(0.16, -1.65, 0), V(0.03, -1.95, 0), 0.025, M.strut));
    for (const dz of [-0.27, 0.27]) {
      const wl = wheel(NR, 0.25);
      wl.position.set(0, -len, dz);
      steer.add(wl);
      wheels.push({ g: wl, r: NR });
    }
    leg.add(cyl(V(-0.05, -0.4, 0), V(-0.9, 0.15, 0), 0.045, M.strut)); // drag brace
    const ld = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.9, 0.5), M.whiteDoor);
    ld.position.set(0.14, -0.6, 0);
    leg.add(shade(ld));
    gear.nose = leg;
    gear.steer = steer;
    // twin doors along the keel, hinged on their outer edges
    for (const side of [1, -1]) {
      const yo = 0.43 * side;
      const s0 = 2.75;
      const s1 = 5.6;
      const surf = (s, y) => {
        const c = (topW(s) + botW(s)) / 2;
        const r = (topW(s) - botW(s)) / 2;
        const k = y / halfW(s);
        return c - r * Math.sqrt(Math.max(0, 1 - k * k)) - 0.012;
      };
      const pv = [(s0 + s1) / 2, yo, surf((s0 + s1) / 2, yo)];
      const hg = new THREE.Group();
      hg.position.copy(Tp(pv));
      air.add(hg);
      const yi = 0.015 * side;
      const dg = slab([[s0, yi, surf(s0, yi)], [s1, yi, surf(s1, yi)], [s1, yo, surf(s1, yo)], [s0, yo, surf(s0, yo)]], 0.03, pv);
      hg.add(shade(new THREE.Mesh(dg, M.whiteDoor)));
      gear.noseDoors.push({ hg, side });
    }
  }

  /* ---------------- lights & antennas ---------------- */
  const glowTex = glowTexture();
  const lights = [];
  const light = (p, color, size, kind) => {
    const g = new THREE.Group();
    g.position.copy(Tp(p));
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), new THREE.MeshBasicMaterial({ color, toneMapped: false }));
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    spr.scale.setScalar(size);
    g.add(bulb, spr);
    air.add(g);
    lights.push({ g, kind, spr, bulb });
  };
  const tipF = wingStation(17.0);
  light([tipF.le[0] + 0.05, 17.08, tipF.le[2] + 0.02], 0x30ff60, 0.6, 'nav');
  light([tipF.le[0] + 0.05, -17.08, tipF.le[2] + 0.02], 0xff2020, 0.6, 'nav');
  light([tipF.le[0] + 0.35, 17.12, tipF.le[2] + 0.02], 0xffffff, 1.1, 'strobe');
  light([tipF.le[0] + 0.35, -17.12, tipF.le[2] + 0.02], 0xffffff, 1.1, 'strobe');
  light([37.1, 0, topW(37.1) + 0.03], 0xffffff, 0.6, 'nav');
  light([16.8, 0, 5.98], 0xff1010, 0.9, 'beacon');
  light([15.4, 0, 1.6], 0xff1010, 0.9, 'beacon');
  {
    const ant = (s, w, h, up) => {
      const m = shade(new THREE.Mesh(new THREE.BoxGeometry(0.32, h, 0.04), M.wing));
      m.position.copy(Tp([s, 0, w + (up ? h / 2 : -h / 2)]));
      m.rotation.z = up ? 0.35 : -0.35;
      air.add(m);
    };
    ant(9.5, topW(9.5), 0.35, true);
    ant(26.0, topW(26.0), 0.3, true);
    ant(8.0, 1.85, 0.28, false);
    // pitot probes
    for (const side of [1, -1]) {
      const p = shade(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.02, 0.22, 6), M.hub));
      p.position.copy(Tp([2.3, 1.2 * side, 3.6]));
      p.rotation.z = Math.PI / 2;
      air.add(p);
    }
  }

  /* ---------------- animation ---------------- */
  const st = { gear: 1, flap: 0, spoilL: 0, spoilR: 0, ail: 0, elev: 0, rud: 0, fan: 0, steer: 0 };
  const flapTarget = { up: 0, takeoff: 0.45, landing: 1 };

  function pose(s) {
    const g = st.gear;
    // gear: doors open 0..0.15, legs swing 0.15..0.85, doors close 0.85..1 (symmetric both ways)
    const door = sstep(0.0, 0.14, g) * (1 - sstep(0.86, 1.0, g));
    const swing = 1 - sstep(0.14, 0.86, g);
    for (const { leg, side } of gear.main) leg.rotation.x = side * swing * 88 * DEG;
    for (const { hg, side } of gear.mainDoors) hg.rotation.x = side * door * 92 * DEG;
    gear.nose.rotation.z = swing * 92 * DEG;
    for (const { hg, side } of gear.noseDoors) hg.rotation.x = -side * door * 88 * DEG;
    gear.steer.rotation.y = st.steer * (1 - swing);

    // high lift: Fowler flaps travel aft and down, slats droop forward
    const f = st.flap;
    const travel = sstep(0, 0.45, f);
    const fAng = lerp(0, 14, sstep(0, 0.45, f)) + lerp(0, 22, sstep(0.45, 1, f));
    for (const hg of ctl.flaps) {
      const c = hg.userData.chord;
      hg.userData.pose(fAng * DEG, -travel * 0.2 * c, -travel * 0.06 * c - sstep(0.45, 1, f) * 0.08);
    }
    const sl = sstep(0, 0.45, f);
    const sAng = lerp(0, 18, sl) + lerp(0, 5, sstep(0.45, 1, f));
    for (const hg of ctl.slats) hg.userData.pose(-sAng * DEG, sl * 0.42, -sl * 0.2);

    for (const hg of ctl.ail) hg.userData.pose((-hg.userData.side * st.ail * 20 + f * 5) * DEG);
    for (const hg of ctl.spoil) hg.userData.pose(-(hg.userData.side > 0 ? st.spoilR : st.spoilL) * DEG);
    for (const hg of ctl.elev) hg.userData.pose(-st.elev * 25 * DEG);
    ctl.rudder.userData.pose(st.rud * 25 * DEG);
  }

  let fanAngle = 0;
  let wheelAngle = 0;
  function update(dt, s) {
    dt = Math.min(dt, 0.1);
    st.gear = approach(st.gear, s.gearDown ? 1 : 0, dt / 5, 1);
    st.flap = approach(st.flap, flapTarget[s.flaps] ?? 0, dt / 6, 1);
    st.ail = approach(st.ail, clamp(s.roll || 0, -1, 1), 3 * dt, 1);
    st.elev = approach(st.elev, clamp(s.pitch || 0, -1, 1), 3 * dt, 1);
    st.rud = approach(st.rud, clamp(s.yaw || 0, -1, 1), 3 * dt, 1);
    const sb = s.speedBrake ? (s.onGround ? 50 : 35) : 0;
    st.spoilR = approach(st.spoilR, Math.max(sb, Math.max(0, st.ail) * 25), 90 * dt, 1);
    st.spoilL = approach(st.spoilL, Math.max(sb, Math.max(0, -st.ail) * 25), 90 * dt, 1);
    st.steer = approach(st.steer, s.onGround ? -clamp(s.yaw || 0, -1, 1) * 40 * DEG : 0, 1.2 * dt, 1);
    pose(s);

    const omega = 2 * Math.PI * (1.5 + 14 * clamp(s.throttle ?? 0, 0, 1));
    fanAngle = (fanAngle + omega * dt) % (2 * Math.PI);
    for (const fan of fans) fan.rotation.x = -fanAngle;
    if (s.onGround && s.gearDown) wheelAngle -= ((s.speed || 0) / MAIN_R) * dt;
    for (const w of wheels) w.g.rotation.z = (wheelAngle * MAIN_R) / w.r;

    const t = s.time ?? 0;
    const beacon = t % 1.1 < 0.12;
    const strobe = t % 1.3 < 0.06 || (t % 1.3 > 0.18 && t % 1.3 < 0.24);
    for (const l of lights) {
      const on = l.kind === 'nav' ? true : l.kind === 'beacon' ? beacon : strobe;
      l.g.visible = on;
    }
  }
  update(0, { gearDown: true, flaps: 'up', throttle: 0, roll: 0, pitch: 0, yaw: 0, onGround: true, speed: 0, time: 0 });

  return {
    id: 'airliner',
    name: 'Airliner (A320-class)',
    root,
    eye: [S_MAIN - 3.6, 4.78, -0.55],
    chaseDistance: 45,
    update,
  };
}
