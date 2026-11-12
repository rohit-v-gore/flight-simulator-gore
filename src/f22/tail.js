import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { STAB, FIN, finLE, finBase } from './dims.js';
import { loft, mirrorY, sectionRing, makeHinge, pivotMesh, mirrorPt, Tp } from './geom.js';
import { linspace, lerp, clamp } from './util.js';

/* Port-side copies of starboard geometry and points. */
const sided = (side, geo) => (side > 0 ? geo : mirrorY(geo));
const sidedPt = (side, p) => (side > 0 ? p : mirrorPt(p));

/* ---------------------------- all-moving stabilators ---------------------------- */

/** Chord line of the starboard stabilator at span station y, with the trailing-edge notch near the root. */
function stabChord(y) {
  const u = (y - STAB.root.y) / (STAB.tip.y - STAB.root.y);
  const notchDepth = y < STAB.root.y + 0.55 ? 0.18 * clamp((y - STAB.root.y) / 0.12, 0, 1) : 0;
  return {
    le: [STAB.root.le + (STAB.tip.le - STAB.root.le) * u, y, STAB.w],
    te: [STAB.root.te + (STAB.tip.te - STAB.root.te) * u - notchDepth, y, STAB.w],
    up: [0, 0, 1],
    t: STAB.tRoot + (STAB.tTip - STAB.tRoot) * u,
    m: 0,
  };
}

/** One stabilator on a pitch hinge at its root. Returns the hinge (use userData.set). */
export function buildStab(side, parent, mats) {
  const skin = loft(linspace(STAB.root.y, STAB.tip.y, 18).map((y) => sectionRing(stabChord(y), 0, 1, 18)), {
    closed: true,
    capStart: true,
    capEnd: true,
  });
  const pivot = sidedPt(side, [STAB.pivot[0], STAB.root.y, STAB.pivot[2]]);
  const hinge = makeHinge(parent, pivot, sidedPt(side, [0, 1, 0]), null, side);
  hinge.add(pivotMesh(sided(side, skin), mats.wing, pivot, 'stabilator'));
  return hinge;
}

/* ------------------------------ canted vertical tails ------------------------------ */

/** Unit vector normal to the starboard fin's plane, pointing outboard. */
const FIN_NORMAL = [0, -Math.cos(FIN.cant), Math.sin(FIN.cant)];

/** Section frame of the starboard fin at height h measured along its canted span. */
function finChord(h) {
  const [le, te] = finLE(h);
  const [y, w] = finBase(h);
  const u = clamp(h / FIN.span, 0, 1);
  return { le: [le, y, w], te: [te, y, w], up: FIN_NORMAL, t: lerp(FIN.tRoot, FIN.tTip, u), m: 0 };
}

/** Chord fraction where the rudder starts at height h (fixed rudder chord). */
function rudderStart(h) {
  const [le, te] = finLE(h);
  return 1 - FIN.rudder.chord / (te - le);
}

function finBand(heights, from, to, nChord) {
  return loft(heights.map((h) => sectionRing(finChord(h), from(h), to(h), nChord)), {
    closed: true,
    capStart: true,
    capEnd: true,
  });
}

function onFin(h, x) {
  const f = finChord(h);
  return f.le.map((v, j) => v + (f.te[j] - v) * x);
}

/** One canted fin with its rudder. Returns { group, rudder } (rudder.userData.set). */
export function buildFin(side, parent, mats) {
  const R = FIN.rudder;
  const leadingEdge = () => 0;
  const trailingEdge = () => 1;
  const lowerH = linspace(-0.15, R.h0, 4);
  const rudderH = linspace(R.h0, R.h1, 12);
  const upperH = linspace(R.h1, FIN.span, 10);
  const fin = mergeGeometries([
    finBand(lowerH, leadingEdge, trailingEdge, 22),
    finBand(rudderH, leadingEdge, rudderStart, 20),
    finBand(upperH, leadingEdge, trailingEdge, 22),
  ]);
  const group = new THREE.Group();
  parent.add(group);
  group.add(pivotMesh(sided(side, fin), mats.body, null, 'verticalTail'));

  const a = onFin(R.h0, rudderStart(R.h0));
  const b = onFin(R.h1, rudderStart(R.h1));
  const pivot = sidedPt(side, a);
  const rudder = makeHinge(group, pivot, sidedPt(side, [b[0] - a[0], b[1] - a[1], b[2] - a[2]]), null, side);
  rudder.add(pivotMesh(sided(side, finBand(rudderH, rudderStart, trailingEdge, 10)), mats.body, pivot, 'rudder'));

  // white tail light at the tip, green formation strip low on the outer face
  const tip = onFin(FIN.span, 1);
  const light = new THREE.Mesh(new THREE.SphereGeometry(0.026, 10, 8), mats.navWhite);
  light.position.copy(Tp(sidedPt(side, [tip[0] + 0.01, tip[1], tip[2] - 0.04])));
  group.add(light);
  const at = onFin(0.95, 0.35);
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.05, 0.006), mats.formation);
  const out = 0.03;
  strip.position.copy(Tp(sidedPt(side, [at[0], at[1] + Math.cos(FIN.cant) * out, at[2] - Math.sin(FIN.cant) * out])));
  strip.rotation.x = side * FIN.cant;
  group.add(strip);

  return { group, rudder };
}
