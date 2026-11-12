import * as THREE from 'three';
import { loft, makeMesh, pivotMesh, T, Tp, mirrorY } from './geom.js';
import { botAt, intakeSection } from './body.js';
import { linspace, sstep } from './util.js';

/*
 * Internal weapons bays. Main ventral bay: six AIM-120 AMRAAMs on LAU-142 launchers that push the missiles
 * clear of the airframe. Side bays in the intake flanks: one AIM-9 Sidewinder each on a LAU-141 trapeze
 * that swings the missile out into the airflow.
 */

export const MAIN_BAY = { s0: 8.45, s1: 12.35, hw: 0.7 };
export const SIDE_BAY = { s0: 6.95, s1: 8.75, wTop: -0.16, wBot: -0.52 };

/**
 * Bay door skin: a thin shell hugging the lower fuselage between stations s0..s1 and buttlines y0..y1.
 * Built as loops around the door's fore-aft section, stacked across its width.
 */
function doorSkin(s0, s1, y0, y1, skin, nAlong = 12, nAcross = 10) {
  const loops = linspace(y0, y1, nAcross).map((y) => {
    const outer = linspace(s0, s1, nAlong).map((s) => [s, y, skin(s, y) - 0.004]);
    const inner = linspace(s1, s0, nAlong).map((s) => [s, y, skin(s, y) + 0.016]);
    return [...outer, outer[outer.length - 1], ...inner, inner[inner.length - 1]];
  });
  return loft(loops, { closed: true, capStart: true, capEnd: true, flip: true });
}

/** A missile along +s with its nose at s = 0, axis at y = w = 0 (design frame). */
function missile(len, dia, mats, kind) {
  const g = new THREE.Group();
  const r = dia / 2;
  const noseL = kind === 'aim9' ? 0.22 : 0.42;
  const bodyMat = mats.missileGrey;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len - noseL, 20), bodyMat);
  body.rotation.z = Math.PI / 2;
  body.position.x = -(noseL + (len - noseL) / 2);
  const nose = new THREE.Mesh(
    kind === 'aim9' ? new THREE.SphereGeometry(r, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2) : new THREE.ConeGeometry(r, noseL, 20),
    kind === 'aim9' ? mats.seeker : mats.missileWhite,
  );
  nose.rotation.z = kind === 'aim9' ? Math.PI / 2 : Math.PI / 2;
  nose.position.x = kind === 'aim9' ? -noseL : -noseL / 2;
  if (kind === 'aim9') {
    const ogive = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.9, noseL, 20), bodyMat);
    ogive.rotation.z = Math.PI / 2;
    ogive.position.x = -noseL / 2 - 0.02;
    g.add(ogive);
  }
  // identification bands: yellow (warhead) and brown (rocket motor)
  const band = (x, mat) => {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.002, r + 0.002, 0.04, 20), mat);
    b.rotation.z = Math.PI / 2;
    b.position.x = -x;
    g.add(b);
  };
  band(noseL + 0.35, mats.bandYellow);
  band(noseL + 0.9, mats.bandBrown);
  // cruciform fins (mid wings + tail controls), rotated 45° like the stowed AMRAAM
  const finSet = (x, span, chord) => {
    for (let k = 0; k < 4; k++) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(chord, span, 0.006), mats.missileGrey);
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      f.position.set(-x, Math.cos(a) * (r + span / 2), Math.sin(a) * (r + span / 2));
      f.rotation.x = -a + Math.PI / 2;
      g.add(f);
    }
  };
  if (kind === 'aim9') {
    finSet(0.42, 0.11, 0.16);
    finSet(len - 0.2, 0.17, 0.26);
  } else {
    finSet(1.45, 0.1, 0.32);
    finSet(len - 0.16, 0.12, 0.2);
  }
  g.add(body, nose);
  g.traverse((o) => {
    if (o.isMesh) o.castShadow = o.receiveShadow = true;
  });
  return g;
}

export function buildBays(parent, mats) {
  const M = MAIN_BAY;
  const doors = [];

  /* ---- main bay ---- */
  const interior = new THREE.Mesh(new THREE.BoxGeometry(M.s1 - M.s0 - 0.06, 0.62, 2 * M.hw - 0.04), mats.bay);
  interior.position.copy(T((M.s0 + M.s1) / 2, 0, botAt((M.s0 + M.s1) / 2, 0) + 0.32));
  interior.material.side = THREE.BackSide;
  parent.add(interior);
  for (const side of [1, -1]) {
    let g = doorSkin(M.s0, M.s1, 0.0, M.hw, botAt);
    if (side === -1) g = mirrorY(g);
    const hingeP = [M.s0, side * M.hw, botAt(M.s0, M.hw)];
    const h = new THREE.Group();
    h.position.copy(Tp(hingeP));
    h.add(pivotMesh(g, mats.body, hingeP, 'mainBayDoor'));
    h.userData.side = side;
    parent.add(h);
    doors.push(h);
  }
  // six AMRAAMs in two staggered rows per side
  const amraams = new THREE.Group();
  parent.add(amraams);
  const slots = [
    [0.14, 0.2], [0.38, 0.32], [0.6, 0.22],
  ];
  for (const side of [1, -1]) {
    for (const [y, up] of slots) {
      const m = missile(3.65, 0.178, mats, 'aim120');
      const s0 = M.s0 + 0.2;
      m.position.copy(T(s0, side * y, botAt(s0, y) + up));
      amraams.add(m);
    }
  }

  /* ---- side bays ---- */
  const sideBays = [];
  const B = SIDE_BAY;
  for (const side of [1, -1]) {
    const sm = (B.s0 + B.s1) / 2;
    const yo = intakeSection(sm).yo;
    const door = new THREE.Group();
    door.position.copy(T(B.s0, side * (yo + 0.004), B.wTop));
    const plate = new THREE.Mesh(new THREE.BoxGeometry(B.s1 - B.s0, B.wTop - B.wBot, 0.02), mats.body);
    plate.position.set(-(B.s1 - B.s0) / 2, -(B.wTop - B.wBot) / 2, side * 0.008);
    plate.castShadow = plate.receiveShadow = true;
    door.add(plate);
    parent.add(door);
    const box = new THREE.Mesh(new THREE.BoxGeometry(B.s1 - B.s0 - 0.06, B.wTop - B.wBot - 0.04, 0.42), mats.bay);
    box.material = mats.bay;
    box.position.copy(T(sm, side * (yo - 0.2), (B.wTop + B.wBot) / 2));
    parent.add(box);
    // trapeze launcher: pivots about an axis along s at the top of the bay
    const trap = new THREE.Group();
    trap.position.copy(T(B.s0, side * (yo - 0.2), B.wTop - 0.02));
    parent.add(trap);
    const aim9 = missile(3.0, 0.127, mats, 'aim9');
    aim9.position.set(-0.05, -0.22, 0);
    trap.add(aim9);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.2, 0.03), mats.metalDark);
    arm.position.set(-1.1, -0.1, 0);
    trap.add(arm);
    sideBays.push({ door, trap, side, box });
  }
  return {
    doors,
    amraams,
    sideBays,
    /** main, side: 0 closed .. 1 fully open (with launchers extended at the end of travel) */
    set(main, side) {
      const dm = sstep(0, 0.7, main);
      for (const d of doors) d.rotation.x = -d.userData.side * dm * 1.75; // swing down and outward
      amraams.position.y = -0.28 * sstep(0.7, 1, main);
      amraams.visible = interior.visible = main > 0.01;
      const ds = sstep(0, 0.6, side);
      const ts = sstep(0.55, 1, side);
      for (const b of sideBays) {
        b.door.rotation.x = -b.side * ds * 1.9; // hinged along the top edge, opens up and outward
        b.trap.rotation.x = -b.side * ts * 1.05;
        b.trap.visible = b.box.visible = side > 0.01;
      }
    },
  };
}

export { makeMesh };
