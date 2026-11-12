import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WING, wingFrame, wingChord } from './dims.js';
import { loft, mirrorY, sectionRing, nacaHalf, camberLine, makeHinge, pivotMesh, mirrorPt, Tp } from './geom.js';
import { linspace } from './util.js';

const sided = (side, geo) => (side > 0 ? geo : mirrorY(geo));
const sidedPt = (side, p) => (side > 0 ? p : mirrorPt(p));

/** Chord fractions of the control-surface cut lines at span station y. */
const lefX = (y) => WING.lef.chord / wingChord(y);
const flaperonX = (y) => 1 - WING.flaperon.chord / wingChord(y);
const aileronX = (y) => 1 - WING.aileron.chord / wingChord(y);

const inRange = (y, r) => y >= r.y0 - 1e-6 && y <= r.y1 + 1e-6;

function piece(y0, y1, x0Fn, x1Fn, nSpan, nChord) {
  const rings = linspace(y0, y1, nSpan).map((y) => sectionRing(wingFrame(y), x0Fn(y), x1Fn(y), nChord));
  return loft(rings, { closed: true, capStart: true, capEnd: true });
}

/** Point on the wing surface (side +1 upper / -1 lower) at span y and chord fraction x, with a normal offset. */
export function wingSurfPt(y, x, side, extra = 0) {
  const { le, te, t, m } = wingFrame(y);
  const chord = te[0] - le[0];
  const height = (camberLine(x, m) + side * nacaHalf(x, t)) * chord;
  return [le[0] + chord * x, y, le[2] + height + extra];
}

/**
 * Build one wing (side = 1 starboard, -1 port). The wing is fixed to the airframe; only the
 * leading-edge flaps, flaperons and ailerons move. Returns { group, hinges, side }.
 */
export function buildWing(side, parent, mats) {
  const W = WING;
  const group = new THREE.Group();
  group.name = `wing${side > 0 ? 'Starboard' : 'Port'}`;
  parent.add(group);

  // fixed structure, split at the control-surface ends so every cut line is straight
  const breaks = [W.yRoot, W.lef.y0, W.flaperon.y1, W.aileron.y0, W.aileron.y1, W.lef.y1, W.yTip];
  const geos = [];
  for (let i = 0; i < breaks.length - 1; i++) {
    const y0 = breaks[i];
    const y1 = breaks[i + 1];
    const mid = (y0 + y1) / 2;
    const x0 = inRange(mid, W.lef) ? lefX : () => 0;
    const x1 = inRange(mid, W.flaperon) ? flaperonX : inRange(mid, W.aileron) ? aileronX : () => 1;
    const n = Math.max(3, Math.round((y1 - y0) * 6));
    geos.push(piece(y0, y1, x0, x1, n, 26));
  }
  group.add(pivotMesh(sided(side, mergeGeometries(geos)), mats.wing, null, 'wingFixed'));

  const hinges = { lef: null, flaperon: null, aileron: null };
  const surface = (r, x0Fn, x1Fn, hingeX, hingeSide, name) => {
    const h0 = wingSurfPt(r.y0, hingeX(r.y0), hingeSide, 0);
    const h1 = wingSurfPt(r.y1, hingeX(r.y1), hingeSide, 0);
    const hp = sidedPt(side, h0);
    const ax = sidedPt(side, [h1[0] - h0[0], h1[1] - h0[1], h1[2] - h0[2]]);
    const hinge = makeHinge(group, hp, ax, null, side);
    hinge.add(pivotMesh(sided(side, piece(r.y0, r.y1, x0Fn, x1Fn, 12, 14)), mats.wing, hp, name));
    return hinge;
  };
  hinges.lef = surface(W.lef, () => 0, lefX, lefX, -1, 'leadingEdgeFlap');
  hinges.flaperon = surface(W.flaperon, flaperonX, () => 1, flaperonX, 0, 'flaperon');
  hinges.aileron = surface(W.aileron, aileronX, () => 1, aileronX, 0, 'aileron');

  // wingtip position light (starboard green, port red) and a formation-light strip
  const tip = wingSurfPt(W.yTip - 0.02, 0.35, 0, 0);
  const nav = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), side === 1 ? mats.navGreen : mats.navRed);
  nav.position.copy(Tp(sidedPt(side, tip)));
  nav.scale.set(1.8, 0.7, 1);
  group.add(nav);
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.006, 0.05), mats.formation);
  const sp = wingSurfPt(W.yTip - 0.35, 0.45, 1, 0.002);
  strip.position.copy(Tp(sidedPt(side, sp)));
  group.add(strip);

  return { group, hinges, side };
}
