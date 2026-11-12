import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { curve, spow, linspace, lerp } from './util.js';
import { loft, makeHinge, pivotMesh, T, Tp } from './geom.js';
import { topAt } from './body.js';

/*
 * Cockpit: a one-piece frameless bubble canopy with the Raptor's gold tint, hinged at the rear so the
 * front lifts. Inside: ACES II seat, pilot, glareshield with a wide-angle HUD, six colour displays,
 * side-stick and throttles.
 */
export const CANOPY = {
  hw: curve([[2.95, 0.26], [3.5, 0.42], [4.4, 0.5], [5.9, 0.5], [6.6, 0.45], [7.05, 0.34]]),
  top: curve([[2.95, 0.2], [3.4, 0.5], [4.2, 0.78], [5.1, 0.9], [5.9, 0.88], [6.6, 0.76], [7.05, 0.62]]),
  squareness: curve([[2.95, 2.0], [4.2, 2.2], [6.0, 2.3], [7.05, 2.4]]),
  hinge: [7.1, 0, 0.5],
  sFront: 2.95,
  sGlass: 6.8,
  sEnd: 7.05,
};

/** Canopy sill height at station s (on the fuselage skin). */
export const sillW = (s) => topAt(s, CANOPY.hw(s)) - 0.012;

/** Canopy surface point at station s; phi runs 0 (starboard sill) .. PI (port sill). */
export function canopyPt(s, phi, inflate = 0) {
  const half = CANOPY.hw(s) + inflate;
  const sill = sillW(s);
  const crown = Math.max(CANOPY.top(s), sill + 0.02) + inflate;
  const e = 2 / CANOPY.squareness(s);
  return [s, half * spow(Math.cos(phi), e), sill + (crown - sill) * spow(Math.sin(phi), e)];
}

const arch = (s, n, inflate = 0) => linspace(0, Math.PI, n).map((phi) => canopyPt(s, phi, inflate));

/* ------------------------------ small parts ------------------------------ */

function solid(geometry, material, at) {
  const m = new THREE.Mesh(geometry, material);
  if (at) m.position.copy(at);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Rounded block of size [x, y, z] (scene axes) centred at `at`. */
function block(size, at, material, radius = 0.02) {
  const r = Math.min(radius, ...size.map((v) => v / 2 - 0.001));
  return solid(new RoundedBoxGeometry(size[0], size[1], size[2], 2, Math.max(r, 0.001)), material, at);
}

function rail(points, radius, material) {
  const c = new THREE.CatmullRomCurve3(points.map(Tp));
  return solid(new THREE.TubeGeometry(c, points.length * 3, radius, 8, false), material);
}

/**
 * ACES II seat in a local frame: x forward, y up the seat back, z lateral. Returns a group that the
 * caller positions and reclines.
 */
function acesSeat(mats) {
  const g = new THREE.Group();
  const add = (size, x, y, z, mat, r) => g.add(block(size, new THREE.Vector3(x, y, z), mat, r));
  add([0.13, 0.78, 0.48], -0.15, 0.32, 0, mats.seat, 0.03); // back shell with parachute
  add([0.1, 0.52, 0.38], -0.04, 0.28, 0, mats.seatPad, 0.04); // back cushion
  add([0.2, 0.2, 0.36], -0.12, 0.72, 0, mats.seat, 0.05); // headrest
  add([0.48, 0.12, 0.46], 0.14, -0.06, 0, mats.seat, 0.03); // seat pan / survival kit
  add([0.42, 0.05, 0.38], 0.14, 0.02, 0, mats.seatPad, 0.02); // cushion
  for (const z of [-0.25, 0.25]) add([0.34, 0.26, 0.03], 0.1, 0.06, z, mats.seat, 0.01); // side panels
  // ejection handles either side of the seat pan, in hazard stripes
  for (const z of [-0.2, 0.2]) {
    const h = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.01, 6, 14, Math.PI), mats.yellowBlack);
    h.position.set(0.3, 0.02, z);
    h.rotation.z = -Math.PI / 2;
    g.add(h);
  }
  return g;
}

/** Seated pilot in the same local frame as the seat. */
function pilotFigure(mats) {
  const g = new THREE.Group();
  const part = (geo, mat, x, y, z = 0, scale = null) => {
    const m = solid(geo, mat, new THREE.Vector3(x, y, z));
    if (scale) m.scale.set(...scale);
    g.add(m);
    return m;
  };
  part(new THREE.CapsuleGeometry(0.16, 0.26, 4, 12), mats.suit, 0.03, 0.22, 0, [0.78, 1, 1.25]); // torso
  part(new THREE.CapsuleGeometry(0.165, 0.16, 4, 12), mats.harness, 0.03, 0.28, 0, [0.8, 1, 1.27]); // vest
  for (const z of [-0.11, 0.11]) {
    const thigh = part(new THREE.CapsuleGeometry(0.07, 0.34, 4, 8), mats.suit, 0.25, 0.02, z);
    thigh.rotation.z = Math.PI / 2;
  }
  const head = part(new THREE.SphereGeometry(0.13, 20, 16), mats.helmet, 0.04, 0.6, 0, [1.07, 1, 0.95]);
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.133, 20, 10, -Math.PI * 0.4, Math.PI * 0.8, Math.PI * 0.32, Math.PI * 0.24), mats.visorGold);
  visor.position.copy(head.position);
  visor.scale.copy(head.scale);
  visor.rotation.y = Math.PI;
  g.add(visor);
  part(new THREE.SphereGeometry(0.055, 12, 8), mats.mask, 0.14, 0.53, 0, [1, 0.9, 0.8]);
  return g;
}

/** Instrument panel facing aft at station sFace, centred at height wCentre. */
function displayPanel(sFace, wCentre, width, height, screens, mats) {
  const g = new THREE.Group();
  g.position.copy(T(sFace, 0, wCentre));
  g.rotation.y = -Math.PI / 2; // panel normal (+Z) points aft
  g.add(new THREE.Mesh(new THREE.PlaneGeometry(width, height), mats.cockpit));
  for (const sc of screens) {
    const frame = new THREE.Mesh(new THREE.PlaneGeometry(sc.w + 0.028, sc.h + 0.028), mats.coaming);
    frame.position.set(sc.y, sc.z, 0.001);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(sc.w, sc.h), sc.mat || mats.display);
    face.position.set(sc.y, sc.z, 0.002);
    g.add(frame, face);
  }
  return g;
}

function goldCanopy(geometry, pivot, mats) {
  const tint = pivotMesh(geometry, mats.glassTint, pivot, 'canopyGlass');
  tint.castShadow = tint.receiveShadow = false;
  tint.renderOrder = 2;
  const sheen = new THREE.Mesh(tint.geometry, mats.glassReflect);
  sheen.renderOrder = 3;
  const g = new THREE.Group();
  g.add(tint, sheen);
  return g;
}

/* -------------------------------- assembly -------------------------------- */

export function buildCockpit(parent, mats) {
  const C = CANOPY;
  const N = 36;

  // canopy glass and its painted aft skirt ride on the rear hinge
  const hinge = makeHinge(parent, C.hinge, [0, 1, 0]);
  const stations = linspace(0, 1, 35).map((u) => lerp(C.sFront, C.sGlass, u ** 1.3));
  hinge.add(goldCanopy(loft(stations.map((s) => arch(s, N)), { closed: false }), C.hinge, mats));
  const skirt = loft(linspace(C.sGlass, C.sEnd, 5).map((s) => arch(s, N, 0.002)), { closed: false });
  hinge.add(pivotMesh(skirt, mats.bodyDouble, C.hinge, 'canopyAft'));
  for (const side of [-1, 1]) {
    const sill = linspace(C.sFront + 0.15, C.sEnd, 14).map((s) => [s, side * (C.hw(s) + 0.006), sillW(s) + 0.012]);
    const r = rail(sill, 0.016, mats.frame);
    r.position.sub(Tp(C.hinge));
    hinge.add(r);
  }

  // dorsal fairing behind the canopy, sloping down into the spine
  const spineEnd = 8.6;
  const fairing = loft(
    linspace(C.sEnd, spineEnd, 10).map((s) => {
      const f = (s - C.sEnd) / (spineEnd - C.sEnd);
      const half = lerp(C.hw(C.sEnd), 0.62, f);
      const crown = lerp(C.top(C.sEnd), topAt(s, 0) + 0.01, f ** 0.8);
      const base = topAt(s, half) - 0.03;
      return linspace(0, Math.PI, N).map((phi) => [s, half * spow(Math.cos(phi), 0.83), base + (Math.max(crown, base + 0.01) - base) * spow(Math.sin(phi), 0.83)]);
    }),
    { closed: false },
  );
  parent.add(pivotMesh(fairing, mats.bodyDouble, null, 'canopyFairing'));

  // interior
  const interior = new THREE.Group();
  parent.add(interior);
  const sPanel = 4.55;
  interior.add(block([0.42, 0.16, 0.8], T(sPanel - 0.05, 0, 0.27), mats.cockpit, 0.03)); // glareshield
  interior.add(block([0.44, 0.03, 0.84], T(sPanel - 0.06, 0, 0.355), mats.coaming, 0.012));
  interior.add(block([0.14, 0.06, 0.24], T(sPanel - 0.1, 0, 0.385), mats.cockpit, 0.01)); // HUD base
  const hud = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.17), mats.hud);
  hud.position.copy(T(sPanel - 0.12, 0, 0.47));
  hud.rotation.set(0, Math.PI / 2, 0);
  hud.rotateX(-0.42);
  interior.add(hud);
  interior.add(
    displayPanel(sPanel + 0.17, 0.16, 0.8, 0.3, [
      { w: 0.2, h: 0.2, y: 0, z: -0.02, mat: mats.mfd }, // primary multifunction display
      { w: 0.15, h: 0.15, y: -0.25, z: -0.04, mat: mats.mfd },
      { w: 0.15, h: 0.15, y: 0.25, z: -0.04, mat: mats.mfd },
      { w: 0.13, h: 0.06, y: -0.18, z: 0.11 },
      { w: 0.13, h: 0.06, y: 0, z: 0.11 },
      { w: 0.13, h: 0.06, y: 0.18, z: 0.11 },
    ], mats),
  );
  for (const side of [-1, 1]) {
    interior.add(block([1.1, 0.08, 0.16], T(5.55, side * 0.38, 0.12), mats.cockpit, 0.015)); // side consoles
    const top = new THREE.Mesh(new THREE.PlaneGeometry(1.04, 0.12), mats.consoleTop);
    top.position.copy(T(5.55, side * 0.38, 0.161));
    top.rotation.x = -Math.PI / 2;
    interior.add(top);
  }
  interior.add(solid(new THREE.CapsuleGeometry(0.022, 0.12, 4, 8), mats.coaming, T(5.2, 0.36, 0.25))); // side-stick
  for (const dy of [-0.03, 0.03]) interior.add(block([0.06, 0.12, 0.04], T(5.35, -0.38 + dy, 0.23), mats.coaming, 0.008));

  const seatS = 5.6;
  const seat = acesSeat(mats);
  const crew = new THREE.Group();
  const pilot = pilotFigure(mats);
  for (const g of [seat, pilot]) {
    g.position.copy(T(seatS, 0, -0.16));
    g.rotation.z = 0.22; // reclined seat back
  }
  pilot.position.x += 0.12;
  crew.add(pilot);
  interior.add(seat, crew);

  // bulkhead behind the seat, cut to the canopy's cross-section
  const sB = 6.55;
  const outline = new THREE.Shape();
  arch(sB, 25, -0.03).forEach((p, k) => (k ? outline.lineTo(p[1], p[2]) : outline.moveTo(p[1], p[2])));
  outline.lineTo(-0.42, 0);
  outline.lineTo(0.42, 0);
  const bulk = solid(new THREE.ExtrudeGeometry(outline, { depth: 0.05, bevelEnabled: false, curveSegments: 1 }), mats.cockpit);
  bulk.rotation.y = Math.PI / 2;
  bulk.position.copy(T(sB + 0.05, 0, 0));
  interior.add(bulk);
  interior.add(block([2.3, 0.04, 0.84], T(5.5, 0, -0.12), mats.cockpit, 0.01)); // tub floor

  return { canopyHinge: hinge, crew, interior };
}
