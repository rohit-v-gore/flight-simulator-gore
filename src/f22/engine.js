import * as THREE from 'three';
import { NOZZLE } from './dims.js';
import { loft, finalize, T, Tp } from './geom.js';
import { lerp, sstep, clamp, linspace, DEG } from './util.js';
import { INTAKE, intakeSection } from './body.js';

/*
 * Pratt & Whitney F119 with two-dimensional convergent-divergent nozzles. Upper and lower flaps move
 * together for ±20° pitch thrust vectoring, and apart to set the exit area (closed at idle/MIL, open in reheat).
 */

/** Rounded-rectangle ring around the nozzle axis, CCW from the bottom centre. */
function rrect(s, yc, wc, hw, hh, r, n = 6) {
  const pts = [];
  const corners = [
    [hw - r, -hh + r, -Math.PI / 2, 0],
    [hw - r, hh - r, 0, Math.PI / 2],
    [-hw + r, hh - r, Math.PI / 2, Math.PI],
    [-hw + r, -hh + r, Math.PI, 1.5 * Math.PI],
  ];
  pts.push([s, yc, wc - hh]);
  for (const [cy, cw, a0, a1] of corners) {
    for (let i = 0; i <= n; i++) {
      const a = lerp(a0, a1, i / n);
      pts.push([s, yc + cy + r * Math.cos(a), wc + cw + r * Math.sin(a)]);
    }
  }
  return pts;
}

function plate(len, width, thick, mat, name) {
  const g = new THREE.BoxGeometry(len, thick, width);
  g.translate(-len / 2, 0, 0); // hinge at the forward edge, plate extends aft (-x)
  const m = new THREE.Mesh(g, mat);
  m.name = name;
  m.castShadow = m.receiveShadow = true;
  return m;
}

/** Side wall: flat plate in the s-w plane with a raked trailing edge. */
function sideWall(side, yOff, N, mats) {
  const shape = new THREE.Shape();
  const top = N.hh + 0.07;
  shape.moveTo(0, -top);
  shape.lineTo(0, top);
  shape.lineTo(N.sExit - N.sHinge + 0.08, top);
  shape.lineTo(N.sExit - N.sHinge - 0.18, -top);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.035, bevelEnabled: false });
  g.translate(0, 0, -0.0175);
  const m = new THREE.Mesh(g, mats.nozzleSolid);
  m.rotation.y = Math.PI; // shape +x -> aft (-X)
  m.position.copy(T(N.sHinge, side * N.y + yOff, N.w));
  m.castShadow = m.receiveShadow = true;
  return m;
}

/* Plume layers: length (m), start half-size scale, end scale, material key. */
const PLUME_LAYERS = [
  { len: 4.4, k0: 1.0, k1: 0.28, mat: 'flameOuter' },
  { len: 3.1, k0: 0.8, k1: 0.18, mat: 'flameMid' },
  { len: 1.8, k0: 0.6, k1: 0.08, mat: 'flameCore' },
];

/**
 * One plume shell in the plume's local frame (x aft is negative, y up, z lateral). Starts as a rounded
 * rectangle the size of the nozzle exit and tapers to a rounded point. uv.y runs 0 (nozzle) .. 1 (tip),
 * uv.x around the shell, for the flame shader.
 */
function plumeShell(N, { len, k0, k1 }) {
  const rings = 20;
  const around = 32;
  const pos = [];
  const uv = [];
  const idx = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const k = lerp(k0, k1, Math.pow(t, 0.8));
    const hw = (N.hw - 0.04) * k;
    const hh = (N.hh - 0.06) * k * lerp(1, 1.4, t); // the jet rounds out downstream
    const e = lerp(0.35, 1, t); // squarish at the exit, round at the tip
    for (let j = 0; j <= around; j++) {
      const a = (j / around) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      pos.push(-t * len, hh * Math.sign(sn) * Math.abs(sn) ** e, hw * Math.sign(c) * Math.abs(c) ** e);
      uv.push(j / around, t);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < around; j++) {
      const a = i * (around + 1) + j;
      const b = a + around + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildEngines(parent, mats) {
  const N = NOZZLE;
  const nozzles = [];
  const flames = [];
  const glowLights = [];

  for (const side of [1, -1]) {
    const yc = side * N.y;
    // fixed nozzle box: outer skin and a dark liner
    const st = linspace(N.s0, N.sHinge, 6);
    const outer = loft(st.map((s) => rrect(s, yc, N.w, N.hw + 0.02 + 0.03 * (1 - (s - N.s0) / (N.sHinge - N.s0)), N.hh + 0.02, 0.07)), {
      closed: true,
    });
    const liner = loft(st.map((s) => rrect(s, yc, N.w, N.hw - 0.02, N.hh - 0.02, 0.05)), { closed: true, flip: true });
    for (const [g, mat] of [[outer, mats.nozzleSolid], [liner, mats.nozzleLiner]]) {
      const m = new THREE.Mesh(finalize(g), mat);
      m.castShadow = m.receiveShadow = true;
      parent.add(m);
    }

    // side walls (fixed)
    for (const sgn of [1, -1]) parent.add(sideWall(side, sgn * (N.hw + 0.005), N, mats));

    // hinged upper and lower divergent flaps
    const L = N.sExit - N.sHinge;
    const mk = (sgn) => {
      const h = new THREE.Group();
      h.position.copy(T(N.sHinge, yc, N.w + sgn * N.hh));
      const outerPlate = plate(L, 2 * N.hw, 0.035, mats.nozzleSolid, 'nozzleFlap');
      outerPlate.position.y = sgn * 0.0;
      h.add(outerPlate);
      parent.add(h);
      return h;
    };
    const upper = mk(1);
    const lower = mk(-1);

    // afterburner liner glow and flame holder
    const holder = new THREE.Mesh(new THREE.PlaneGeometry(2 * N.hw - 0.08, 2 * N.hh - 0.08), mats.flameHolder);
    holder.position.copy(T(N.s0 + 0.15, yc, N.w));
    holder.rotation.y = -Math.PI / 2;
    parent.add(holder);
    for (let k = 0; k < 3; k++) {
      const gutter = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 2 * N.hw - 0.12), mats.metalDark);
      gutter.position.copy(T(N.s0 + 0.2, yc, N.w + lerp(-0.15, 0.15, k / 2)));
      parent.add(gutter);
    }

    // exhaust plume: three nested lofted shells shaped to the rectangular exit, pivoting with the vector
    const pivot = new THREE.Group();
    pivot.position.copy(T(N.sHinge, yc, N.w));
    parent.add(pivot);
    const plume = new THREE.Group();
    plume.position.x = -L + 0.02;
    for (const layer of PLUME_LAYERS) {
      const m = new THREE.Mesh(plumeShell(N, layer), mats[layer.mat]);
      m.renderOrder = 5;
      m.frustumCulled = false;
      plume.add(m);
    }
    plume.visible = false;
    pivot.add(plume);
    flames.push(plume);

    const glow = new THREE.PointLight(0xff8a3a, 0, 9, 1.6);
    glow.position.copy(T(N.sExit + 1.8, yc, N.w));
    parent.add(glow);
    glowLights.push(glow);

    nozzles.push({ upper, lower, pivot });
  }

  // engine fan faces with spinners, deep in each intake
  for (const side of [1, -1]) {
    const sec = intakeSection(INTAKE.sFan);
    const sp = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.3, 24), mats.metalDark);
    sp.rotation.z = -Math.PI / 2;
    sp.position.copy(T(INTAKE.sFan - 0.14, side * (sec.yi + sec.yo) / 2, (sec.wti + sec.wbi + sec.wto + sec.wbo) / 4));
    parent.add(sp);
  }

  return {
    flames,
    nozzles,
    /** throttle 0..1 (MIL), ab 0..1, vector in degrees (+ = exhaust deflected up, pushing the nose up), t seconds */
    update(throttle, ab, vector, t) {
      // flaps close slightly with power, open wide in reheat
      const open = lerp(4 - 3 * clamp(throttle, 0, 1), -7, sstep(0, 0.4, ab));
      const v = clamp(vector, -N.vector, N.vector);
      for (const n of nozzles) {
        n.upper.rotation.z = (open - v) * DEG;
        n.lower.rotation.z = (-open - v) * DEG;
        n.pivot.rotation.z = -v * DEG;
      }
      // the liner glows dull red at military power and bright in reheat
      const glowLevel = clamp(0.25 * throttle + 2.2 * ab * ab, 0, 2.5);
      mats.flameHolder.emissiveIntensity = glowLevel;
      const pulse = 1 + 0.06 * Math.sin(t * 41.3) * Math.sin(t * 17.1);
      for (const f of flames) {
        f.visible = ab > 0.01;
        f.scale.set(lerp(0.45, 1, ab) * pulse, 1, 1);
      }
      mats.setFlame(ab, t);
      for (const l of glowLights) l.intensity = 38 * ab * pulse;
    },
  };
}

export { Tp };
