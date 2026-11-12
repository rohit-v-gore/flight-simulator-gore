import * as THREE from 'three';
import { GEAR, DIM } from './dims.js';
import { T } from './geom.js';
import { botAt } from './body.js';
import { sstep, lerp } from './util.js';

/*
 * Landing gear. Each leg is a group pivoting at its trunnion; parts are placed in the leg's own frame
 * using design coordinates relative to the trunnion. Doors open first, then the leg swings down.
 */

const GROUND_W = DIM.groundW;
const rad = THREE.MathUtils.degToRad;

function finish(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Wheel: a squashed-torus tyre around a two-piece hub; the axle is the local Z axis. */
export function makeWheel(radius, width, mats) {
  const wheel = new THREE.Group();
  const tyre = finish(new THREE.Mesh(new THREE.TorusGeometry(radius - width / 2, width / 2, 14, 40), mats.rubber));
  tyre.scale.z = 0.92;
  const rim = finish(new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, width * 0.84, 32), mats.hub));
  const cap = finish(new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.24, radius * 0.3, width * 0.95, 20), mats.metal));
  rim.rotation.x = cap.rotation.x = Math.PI / 2;
  wheel.add(tyre, rim, cap);
  return wheel;
}

/** Round bar between two scene-space points, radius r at `a` tapering to r2 at `b`. */
export function strut(a, b, r, mat, r2 = r, seg = 16) {
  const span = new THREE.Vector3().subVectors(b, a);
  const bar = finish(new THREE.Mesh(new THREE.CylinderGeometry(r2, r, span.length(), seg), mat));
  bar.position.addVectors(a, b).multiplyScalar(0.5);
  bar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), span.normalize());
  return bar;
}

/** Leg frame: a pivot group at `trunnion` (design point) and a helper for local points. */
function legFrame(parent, trunnion) {
  const pivot = new THREE.Group();
  const origin = T(...trunnion);
  pivot.position.copy(origin);
  parent.add(pivot);
  return { pivot, at: (s, y, w) => T(s, y, w).sub(origin) };
}

/** Flat door with sawtooth ends; lies in the local XZ plane extending +Z from its hinge line. */
function sawtoothDoor(length, width, mat, teeth = 2) {
  const outline = new THREE.Shape();
  const pitch = width / teeth;
  const notch = 0.12;
  outline.moveTo(-length / 2, 0);
  for (let k = 0; k < teeth; k++) {
    outline.lineTo(-length / 2 - notch, (k + 0.5) * pitch);
    outline.lineTo(-length / 2, (k + 1) * pitch);
  }
  outline.lineTo(length / 2, width);
  for (let k = teeth - 1; k >= 0; k--) {
    outline.lineTo(length / 2 - notch, (k + 0.5) * pitch);
    outline.lineTo(length / 2, k * pitch);
  }
  const geo = new THREE.ExtrudeGeometry(outline, { depth: 0.014, bevelEnabled: false });
  geo.rotateX(Math.PI / 2); // outline Y -> scene Z, thickness downward
  return finish(new THREE.Mesh(geo, mat));
}

/** Pale, recessed rectangle standing in for a wheel well. */
function wellLiner(length, width, mats) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(length, 0.02, width), mats.well);
  m.receiveShadow = true;
  return m;
}

/* --------------------------------- nose gear --------------------------------- */

export function buildNoseGear(parent, mats) {
  const N = GEAR.nose;
  const trunnion = [N.s + 0.22, 0, botAt(N.s + 0.22, 0) + 0.12];
  const { pivot, at } = legFrame(parent, trunnion);
  const axleW = GROUND_W + N.wheelR;
  const knee = at(N.s + 0.14, 0, lerp(trunnion[2], axleW, 0.62));
  const axle = at(N.s, 0, axleW);
  const lift = (v, dy) => v.clone().add(new THREE.Vector3(0, dy, 0));

  pivot.add(strut(new THREE.Vector3(), knee, 0.07, mats.gear)); // oleo cylinder
  pivot.add(strut(knee, lift(axle, 0.12), 0.048, mats.chrome)); // piston
  for (const z of [-1, 1]) {
    const fork = finish(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.34, 0.03), mats.gear));
    fork.position.copy(lift(axle, 0.12)).add(new THREE.Vector3(0, 0, z * (N.wheelW / 2 + 0.03)));
    pivot.add(fork);
  }
  const crown = finish(new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.04, N.wheelW + 0.1), mats.gear));
  crown.position.copy(lift(axle, 0.3));
  pivot.add(crown);
  const wheel = makeWheel(N.wheelR, N.wheelW, mats);
  wheel.position.copy(axle);
  pivot.add(wheel);
  pivot.add(strut(knee.clone().add(new THREE.Vector3(-0.08, 0, 0)), lift(axle, 0.3).add(new THREE.Vector3(-0.08, 0, 0)), 0.018, mats.gear)); // torque link
  pivot.add(strut(at(N.s + 0.1, 0, trunnion[2] - 0.55), at(N.s - 0.55, 0, trunnion[2] - 0.05), 0.03, mats.gear)); // drag brace
  const taxiLight = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.05, 16), mats.lamp);
  taxiLight.rotation.z = Math.PI / 2;
  taxiLight.position.copy(at(N.s - 0.08, 0, trunnion[2] - 0.75));
  pivot.add(taxiLight);

  // two doors hinged along the bay's outer edges
  const bayS = N.s - 0.2;
  const bayW = botAt(bayS, 0.2) + 0.01;
  const doors = [-1, 1].map((side) => {
    const hinge = new THREE.Group();
    hinge.position.copy(T(bayS, side * 0.2, bayW));
    const panel = finish(new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.012, 0.2), mats.paintLower));
    panel.position.z = -side * 0.1;
    hinge.add(panel);
    hinge.userData.side = side;
    parent.add(hinge);
    return hinge;
  });
  const well = wellLiner(1.1, 0.38, mats);
  well.position.copy(T(bayS, 0, bayW + 0.02));
  parent.add(well);

  return {
    /** ext: 0 stowed .. 1 down and locked. */
    set(ext) {
      const doorsOpen = Math.min(1, ext * 3);
      const leg = sstep(0.2, 1, ext);
      pivot.rotation.z = rad(105) * (1 - leg); // stows forward
      pivot.visible = leg > 0.01;
      for (const d of doors) {
        d.rotation.x = -d.userData.side * rad(88) * sstep(0, 1, doorsOpen);
        d.visible = doorsOpen > 0.01;
      }
      well.visible = doorsOpen > 0.01;
    },
  };
}

/* --------------------------------- main gear --------------------------------- */

export function buildMainGear(parent, side, mats) {
  const M = GEAR.main;
  const trunnionY = 1.32;
  const trunnion = [M.s - 0.1, side * trunnionY, botAt(M.s - 0.1, trunnionY) + 0.15];
  const { pivot, at } = legFrame(parent, trunnion);
  const atSide = (s, y, w) => at(s, side * y, w);
  const axleW = GROUND_W + M.wheelR;
  const piston = atSide(M.s, M.y - 0.2, axleW + 0.08);
  const knee = atSide(M.s - 0.02, lerp(trunnionY, M.y - 0.2, 0.55), lerp(trunnion[2], axleW, 0.5));
  pivot.add(strut(new THREE.Vector3(), knee, 0.09, mats.gear, 0.1));
  pivot.add(strut(knee, piston, 0.065, mats.chrome));
  pivot.add(strut(knee.clone().add(new THREE.Vector3(0.1, -0.05, 0)), piston.clone().add(new THREE.Vector3(0.1, 0.12, 0)), 0.022, mats.gear));
  pivot.add(strut(knee, atSide(M.s + 0.75, trunnionY - 0.1, trunnion[2] - 0.05), 0.04, mats.gear));

  // the wheel and its axle twist flat as the leg stows
  const bogie = new THREE.Group();
  bogie.position.copy(piston);
  pivot.add(bogie);
  const wheel = makeWheel(M.wheelR, M.wheelW, mats);
  wheel.position.copy(atSide(M.s, M.y, axleW)).sub(piston);
  bogie.add(wheel, strut(new THREE.Vector3(), wheel.position.clone().setY(0), 0.04, mats.metal));
  const brake = finish(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.14), mats.gear));
  brake.position.y = 0.04;
  bogie.add(brake);

  // large door hinged at its outboard edge
  const doorS = M.s - 0.15;
  const inboard = 1.02;
  const outboard = 1.78;
  const door = new THREE.Group();
  door.position.copy(T(doorS, side * outboard, botAt(doorS, outboard) + 0.005));
  const panel = sawtoothDoor(1.55, outboard - inboard, mats.paintLower);
  if (side > 0) panel.scale.z = -1; // extend inboard
  door.add(panel);
  parent.add(door);
  const well = wellLiner(1.5, outboard - inboard - 0.06, mats);
  well.position.copy(T(doorS, side * (inboard + outboard) / 2, botAt(doorS, (inboard + outboard) / 2) + 0.03));
  parent.add(well);

  return {
    /** ext: 0 stowed .. 1 down and locked. */
    set(ext) {
      const doorOpen = Math.min(1, ext * 2.5);
      const leg = sstep(0.15, 1, ext);
      pivot.rotation.z = rad(92) * (1 - leg);
      pivot.visible = leg > 0.01;
      bogie.rotation.y = side * (Math.PI / 2) * (1 - sstep(0.3, 0.9, leg));
      door.rotation.x = -side * 1.5 * sstep(0, 1, doorOpen);
      door.visible = doorOpen > 0.01;
      well.visible = doorOpen > 0.01;
    },
  };
}
