import * as THREE from 'three';
import { cosspace } from './util.js';

/*
 * Geometry helpers. Airframe parts are designed in an aircraft frame:
 *   s = metres aft of the nose tip, y = metres to starboard, w = metres up.
 * The scene uses Three.js axes with the nose pointing at +X: X = -s, Y = w, Z = y.
 */

export const T = (s, y, w) => new THREE.Vector3(-s, w, y);
export const Tp = ([s, y, w]) => new THREE.Vector3(-s, w, y);
export const mirrorPt = ([s, y, w]) => [s, -y, w];

/**
 * Skin a sequence of cross-section rings into one indexed mesh.
 * Every ring needs the same number of points; points are [s, y, w].
 * Rings ordered counter-clockwise when looking forward along the loft give outward normals
 * (pass `flip` for the opposite). Repeating a point in a ring makes a sharp crease there.
 */
export function loft(rings, { closed = true, capStart = false, capEnd = false, flip = false, color = null } = {}) {
  const count = rings[0].length;
  const positions = [];
  const colors = [];
  const index = [];
  const pushVertex = (p, ri, pi) => {
    positions.push(p[0], p[1], p[2]);
    if (color) colors.push(...color(ri, pi, p));
  };
  rings.forEach((ring, ri) => {
    if (ring.length !== count) throw new Error(`loft: ring ${ri} has ${ring.length} points, expected ${count}`);
    ring.forEach((p, pi) => pushVertex(p, ri, pi));
  });
  const tri = (a, b, c) => (flip ? index.push(a, c, b) : index.push(a, b, c));
  const span = closed ? count : count - 1;
  for (let r = 0; r + 1 < rings.length; r++) {
    for (let k = 0; k < span; k++) {
      const k2 = (k + 1) % count;
      const a = r * count + k;
      const b = r * count + k2;
      const c = (r + 1) * count + k2;
      const d = (r + 1) * count + k;
      tri(a, b, c);
      tri(a, c, d);
    }
  }
  // end caps: a fan from the ring's centroid (cap vertices are duplicated so they shade flat)
  const cap = (ri, facingAft) => {
    const ring = rings[ri];
    const start = positions.length / 3;
    const centre = [0, 0, 0];
    for (const p of ring) for (let j = 0; j < 3; j++) centre[j] += p[j] / count;
    ring.forEach((p, pi) => pushVertex(p, ri, pi));
    pushVertex(centre, ri, 0);
    const mid = start + count;
    for (let k = 0; k < span; k++) {
      const a = start + k;
      const b = start + ((k + 1) % count);
      if (facingAft) tri(mid, a, b);
      else tri(mid, b, a);
    }
  };
  if (capStart) cap(0, false);
  if (capEnd) cap(rings.length - 1, true);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (color) geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(index);
  return geo;
}

/** Copy of a design-frame geometry mirrored to the port side (winding fixed so normals stay outward). */
export function mirrorY(geo) {
  const out = geo.clone();
  const pos = out.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, -pos.getY(i));
  const idx = out.index.array;
  for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
  return out;
}

/**
 * Convert a design-frame geometry in place to scene axes, relative to `pivot` (design point) if given.
 * The design coordinates are kept as the `aRef` attribute so the livery can be projected in that frame.
 */
export function finalize(geo, pivot = null) {
  const pos = geo.attributes.position;
  const ref = new Float32Array(pos.array);
  const [ps, py, pw] = pivot || [0, 0, 0];
  for (let i = 0; i < pos.count; i++) {
    const s = ref[3 * i];
    const y = ref[3 * i + 1];
    const w = ref[3 * i + 2];
    pos.setXYZ(i, ps - s, w - pw, y - py);
  }
  geo.setAttribute('aRef', new THREE.BufferAttribute(ref, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

function shadowed(mesh, name) {
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Mesh placed in its parent at the design position of `pivot` (or the origin). */
export function makeMesh(geo, material, pivot = null, name = '') {
  const mesh = shadowed(new THREE.Mesh(finalize(geo, pivot), material), name);
  if (pivot) mesh.position.copy(Tp(pivot));
  return mesh;
}

/** Mesh whose geometry is relative to `pivot`, for adding to a hinge group sitting at that pivot. */
export function pivotMesh(geo, material, pivot = null, name = '') {
  return shadowed(new THREE.Mesh(finalize(geo, pivot), material), name);
}

/**
 * Group hinged about a design-frame axis through `pivot`. `parentPivot` is the design point the parent
 * group sits at (if any). Port-side hinges (side = -1) negate the angle, so the same input deflects both
 * sides symmetrically. Use `hinge.userData.set(radians)`.
 */
export function makeHinge(parent, pivot, axis, parentPivot = null, side = 1) {
  const hinge = new THREE.Group();
  hinge.position.copy(Tp(pivot));
  if (parentPivot) hinge.position.sub(Tp(parentPivot));
  const a = Tp(axis).normalize();
  hinge.userData.axis = a;
  hinge.userData.side = side;
  hinge.userData.set = (angle) => hinge.quaternion.setFromAxisAngle(a, angle * side);
  parent.add(hinge);
  return hinge;
}

/* ------------------------------- Sections ------------------------------- */

/** Half-thickness of a symmetric NACA 4-digit section at chord fraction x (closed trailing edge). */
export function nacaHalf(x, thickness) {
  const u = Math.min(1, Math.max(0, x));
  return 5 * thickness * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u ** 2 + 0.2843 * u ** 3 - 0.1036 * u ** 4);
}

/** Parabolic camber line height at chord fraction x for maximum camber m. */
export function camberLine(x, m) {
  return 4 * m * x * (1 - x);
}

/**
 * Closed airfoil ring for the chord band [x0, x1] of a lifting-surface section.
 * frame = { le, te, up, t, m }: leading/trailing edge points, unit normal of the chord plane,
 * thickness ratio and camber. The ring runs along the upper surface from x0 to x1, down a flat
 * face at x1 (if the band stops short of the trailing edge), back along the lower surface, and up a
 * face at x0 (if it starts aft of the leading edge). Corners are doubled so they crease.
 */
export function sectionRing(frame, x0, x1, nChord, { faceN = 3, minThick = 0.004 } = {}) {
  const { le, te, up, t, m = 0 } = frame;
  const chord = Math.hypot(te[0] - le[0], te[1] - le[1], te[2] - le[2]);
  const at = (x, side) => {
    const half = Math.max(nacaHalf(x, t) * chord, x > 0.999 ? minThick / 2 : 0);
    const off = camberLine(x, m) * chord + side * half;
    return [0, 1, 2].map((j) => le[j] + (te[j] - le[j]) * x + up[j] * off);
  };
  const xs = cosspace(nChord).map((u) => x0 + (x1 - x0) * u);
  const ring = xs.map((x) => at(x, 1));
  const face = (from, to, steps) => {
    for (let k = 1; k < steps; k++) ring.push(from.map((v, j) => v + ((to[j] - v) * k) / steps));
  };
  const aftTop = at(x1, 1);
  const aftBot = at(x1, -1);
  ring.push(aftTop);
  face(aftTop, aftBot, x1 < 1 - 1e-6 ? faceN : 1);
  ring.push(aftBot, aftBot.slice());
  const hasFore = x0 > 1e-6;
  for (let i = xs.length - 2; i >= (hasFore ? 0 : 1); i--) ring.push(at(xs[i], -1));
  if (hasFore) {
    const foreBot = at(x0, -1);
    const foreTop = at(x0, 1);
    ring.push(foreBot);
    face(foreBot, foreTop, faceN);
    ring.push(foreTop);
  }
  return ring;
}

/**
 * Superellipse ring around an axis along s at (yc, wc): half-width ry, upper and lower half-heights,
 * exponent n (2 = ellipse, larger = squarer). `count` points, counter-clockwise from `start` radians.
 */
export function ellipseRing(s, yc, wc, ry, rUp, rDown, n, count, start = -Math.PI / 2) {
  const e = 2 / n;
  return Array.from({ length: count }, (_, i) => {
    const a = start + (2 * Math.PI * i) / count;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    return [s, yc + ry * Math.sign(c) * Math.abs(c) ** e, wc + (sn >= 0 ? rUp : rDown) * Math.sign(sn) * Math.abs(sn) ** e];
  });
}
