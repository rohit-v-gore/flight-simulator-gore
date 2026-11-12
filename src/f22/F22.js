import * as THREE from 'three';
import { DEG, clamp, sstep, approach } from './util.js';
import { T, Tp, mirrorY, makeMesh } from './geom.js';
import { DIM, NOZZLE, WING } from './dims.js';
import { buildFuselage, buildIntake, topAt, botAt } from './body.js';
import { buildWing, wingSurfPt } from './wing.js';
import { buildStab, buildFin } from './tail.js';
import { buildNoseGear, buildMainGear } from './gear.js';
import { buildCockpit } from './cockpit.js';
import { buildEngines } from './engine.js';
import { buildBays } from './bays.js';
import { createMaterials, isLiveryMaterial } from './materials.js';

/* ------------------------------- Helpers ------------------------------- */

/**
 * Primitive meshes (boxes etc.) painted with the livery have no design coordinates. Freeze their
 * current local transform into the geometry and derive `aRef` from their position relative to the
 * airframe, so the projected paint lines up with the lofted skin around them.
 */
function addDesignRefs(airframe) {
  airframe.updateMatrixWorld(true);
  const toAirframe = new THREE.Matrix4();
  const airframeInv = airframe.matrixWorld.clone().invert();
  const p = new THREE.Vector3();
  const targets = [];
  airframe.traverse((o) => {
    if (o.isMesh && isLiveryMaterial(o.material) && !o.geometry.getAttribute('aRef')) targets.push(o);
  });
  for (const mesh of targets) {
    const geo = mesh.geometry.clone().applyMatrix4(mesh.matrix);
    mesh.position.set(0, 0, 0);
    mesh.rotation.set(0, 0, 0);
    mesh.scale.set(1, 1, 1);
    mesh.updateMatrixWorld(true);
    toAirframe.multiplyMatrices(airframeInv, mesh.parent.matrixWorld);
    const pos = geo.getAttribute('position');
    const ref = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(toAirframe);
      ref.set([-p.x, p.z, p.y], i * 3); // scene (x, y, z) -> design (s, y, w)
    }
    geo.setAttribute('aRef', new THREE.BufferAttribute(ref, 3));
    geo.computeVertexNormals();
    mesh.geometry = geo;
  }
}

/* -------------------------------- Model -------------------------------- */

/** Pilot inputs and switch positions (what the cockpit commands). */
function defaultInputs() {
  return {
    mach: 0.4,
    flaps: 'up', // up | takeoff | landing
    gearDown: true,
    canopyOpen: false,
    hookDown: false,
    speedBrake: false,
    mainBay: false,
    sideBays: false,
    thrustVectoring: true,
    throttle: 0.3,
    afterburner: 0,
    pitch: 0,
    roll: 0,
    yaw: 0,
    tanks: false,
    lights: true,
  };
}

/** Actual positions of everything that moves (degrees, or 0..1 for travel). */
function restingPositions() {
  const zeroed = ['lef', 'flaperonR', 'flaperonL', 'aileronR', 'aileronL', 'stabR', 'stabL', 'rudderR', 'rudderL', 'vector', 'canopy', 'hook', 'mainBay', 'sideBay', 'speedBrake', 'ab'];
  return { ...Object.fromEntries(zeroed.map((k) => [k, 0])), gear: 1, throttle: 0.3 };
}

/**
 * The aircraft. `state` holds commands, `pos` the surfaces' current positions; `update(dt)` moves each
 * position towards its command at a realistic actuator rate and poses the model.
 */
export class F22 {
  constructor(renderer, opts = {}) {
    const mats = createMaterials(renderer, opts.livery || 'raptor');
    this.mats = mats;
    this.root = new THREE.Group();
    this.root.name = 'F-22 Raptor';
    // the airframe group puts the design origin (nose tip) so the wheels sit on y = 0
    const airframe = new THREE.Group();
    airframe.name = 'airframe';
    airframe.position.set(DIM.centerS, -DIM.groundW, 0);
    this.root.add(airframe);
    this.airframe = airframe;

    const skin = (geometry, material, name) => airframe.add(makeMesh(geometry, material, null, name)).children.at(-1);
    skin(buildFuselage(), mats.body, 'fuselage');
    // build both intakes in design space first: makeMesh converts geometry in place
    const starboard = buildIntake();
    const port = Object.fromEntries(Object.entries(starboard).map(([part, g]) => [part, mirrorY(g)]));
    for (const [side, parts] of [['Starboard', starboard], ['Port', port]]) {
      skin(parts.shell, mats.body, `intake${side}`);
      skin(parts.lip, mats.bodyDouble, `intakeLip${side}`);
      skin(parts.duct, mats.duct, `intakeDuct${side}`).castShadow = false;
      skin(parts.fan, mats.metalDark, `fanFace${side}`);
    }
    this.buildDetails(airframe);

    const bothSides = (build) => [build(1), build(-1)];
    this.wings = bothSides((side) => buildWing(side, airframe, mats));
    this.stabs = bothSides((side) => buildStab(side, airframe, mats));
    this.fins = bothSides((side) => buildFin(side, airframe, mats));
    this.mainGear = bothSides((side) => buildMainGear(airframe, side, mats));
    this.noseGear = buildNoseGear(airframe, mats);
    this.engines = buildEngines(airframe, mats);
    this.cockpit = buildCockpit(airframe, mats);
    this.bays = buildBays(airframe, mats);
    this.buildHook(airframe);
    this.stores = this.buildStores(airframe);
    addDesignRefs(airframe);

    this.state = defaultInputs();
    this.pos = restingPositions();
    this.info = { notes: [] };
    this.weightOnWheels = true; // while set, the gear handle is locked down
    this.wowWarn = 0;
    this.time = 0;
    this.setTanks(false);
    this.update(0, true);
  }

  /* ---------------------------- Extra parts ---------------------------- */

  buildDetails(af) {
    const mats = this.mats;
    // anti-collision strobes, flush on the spine and the belly
    const dome = new THREE.SphereGeometry(0.045, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    const strobeTop = new THREE.Mesh(dome, mats.beacon);
    strobeTop.position.copy(Tp([12.6, 0, topAt(12.6, 0) - 0.01]));
    const strobeBelly = new THREE.Mesh(dome, mats.beacon);
    strobeBelly.position.copy(Tp([13.2, 0, botAt(13.2, 0) + 0.01]));
    strobeBelly.scale.y = -1;
    af.add(strobeTop, strobeBelly);
    // low-profile communication antennas
    const antenna = (s, w, height, below) => {
      const geo = new THREE.CylinderGeometry(0.004, 0.03, height, 3, 1);
      geo.scale(4, 1, 0.35);
      const m = new THREE.Mesh(geo, mats.metalDark);
      m.position.copy(Tp([s, 0, w + (below ? -height / 2 : height / 2)]));
      m.rotation.z = below ? Math.PI - 0.5 : 0.5; // raked back
      m.castShadow = true;
      af.add(m);
    };
    antenna(10.8, topAt(10.8, 0), 0.08, false);
    antenna(13.9, botAt(13.9, 0), 0.08, true);
    // formation-light strips on the forward fuselage
    for (const side of [1, -1]) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.05, 0.006), mats.formation);
      strip.position.copy(Tp([3.9, side * 0.66, -0.08]));
      af.add(strip);
    }
  }

  buildHook(af) {
    const mats = this.mats;
    // emergency arresting hook, stowed flush between the engines; swings down about its forward end
    const root = [16.25, 0, botAt(16.25, 0) + 0.05];
    const length = 1.2;
    const hook = new THREE.Group();
    hook.position.copy(Tp(root));
    af.add(hook);
    const shank = new THREE.Mesh(new THREE.BoxGeometry(length, 0.05, 0.06), mats.metalDark);
    shank.position.x = -length / 2;
    const shoe = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.12, 4, 8), mats.metal);
    shoe.rotation.z = Math.PI / 2;
    shoe.position.set(-length - 0.02, -0.03, 0);
    for (const m of [shank, shoe]) {
      m.castShadow = true;
      hook.add(m);
    }
    this.hook = hook;
  }

  buildStores(af) {
    const mats = this.mats;
    const group = new THREE.Group();
    group.name = 'stores';
    af.add(group);
    // 600 US gal ferry tanks on the inboard wing stations: a lathed teardrop under a slim pylon
    const y = 3.05;
    const wingUnder = wingSurfPt(y, 0.4, -1)[2];
    const radius = 0.36;
    const length = 5.6;
    const sNose = WING.leS(y) - 1.2;
    const centreW = wingUnder - 0.32 - radius;
    const profile = [];
    for (let i = 0; i <= 32; i++) {
      const u = i / 32;
      // ogive nose, parallel middle, long tapering tail
      const r = u < 0.28 ? radius * Math.sin((u / 0.28) * Math.PI / 2) ** 0.7 : u > 0.65 ? radius * (1 - 0.85 * ((u - 0.65) / 0.35) ** 1.6) : radius;
      profile.push(new THREE.Vector2(Math.max(r, 0.004), -u * length));
    }
    const tankGeo = new THREE.LatheGeometry(profile, 36);
    tankGeo.rotateZ(Math.PI / 2); // lathe axis (-Y) -> aft (-X)
    const pylonGeo = new THREE.BoxGeometry(2.0, wingUnder - (centreW + radius) + 0.06, 0.07);
    for (const side of [1, -1]) {
      const tank = new THREE.Mesh(tankGeo, mats.store);
      tank.position.copy(T(sNose, side * y, centreW));
      const pylon = new THREE.Mesh(pylonGeo, mats.store);
      pylon.position.copy(T(sNose + 2.6, side * y, (wingUnder + centreW + radius) / 2));
      for (const m of [tank, pylon]) {
        m.castShadow = m.receiveShadow = true;
        group.add(m);
      }
    }
    return { tanks: group };
  }

  setTanks(on) {
    this.state.tanks = on;
    this.stores.tanks.visible = on;
  }

  setLivery(key, opts) {
    return this.mats.setLivery(key, opts);
  }

  /* ------------------------------ Systems ------------------------------ */

  /**
   * Advance the simulation. dt in seconds; `instant` snaps everything to its target.
   */
  update(dt, instant = false) {
    const S = this.state;
    const P = this.pos;
    this.time += dt;
    const notes = [];
    // move a position towards its command at `rate` units per second (or jump there when `instant`)
    const drive = (key, target, rate) => {
      P[key] = instant ? target : approach(P[key], target, rate, dt);
    };

    // high lift: leading-edge flaps and flaperons droop together, retracted at speed
    let [lefCmd, flapCmd] = { up: [0, 0], takeoff: [15, 20], landing: [22, 30] }[S.flaps] || [0, 0];
    if (S.mach > 0.6 && S.flaps !== 'up') {
      lefCmd = flapCmd = 0;
      notes.push('High-lift retracted above Mach 0.6');
    }
    drive('lef', lefCmd, 15);

    // speed brake = control-surface mix: ailerons up, flaperons down, rudders toed out
    drive('speedBrake', S.speedBrake ? 1 : 0, 1.5);
    const sb = P.speedBrake;
    const roll = S.roll;
    const nosePitch = S.pitch >= 0 ? 25 * S.pitch : 20 * S.pitch; // stabilator trailing edge up = positive
    drive('aileronR', clamp(-25 * roll - 30 * sb, -30, 25), 90);
    drive('aileronL', clamp(25 * roll - 30 * sb, -30, 25), 90);
    drive('flaperonR', clamp(flapCmd - 20 * roll + 30 * sb, -20, 35), 70);
    drive('flaperonL', clamp(flapCmd + 20 * roll + 30 * sb, -20, 35), 70);
    drive('stabR', clamp(nosePitch + 10 * roll, -25, 30), 60);
    drive('stabL', clamp(nosePitch - 10 * roll, -25, 30), 60);
    drive('rudderR', clamp(30 * S.yaw + 25 * sb, -30, 30), 80);
    drive('rudderL', clamp(30 * S.yaw - 25 * sb, -30, 30), 80);
    drive('vector', S.thrustVectoring ? NOZZLE.vector * S.pitch : 0, 40);
    if (sb > 0.01 && Math.abs(roll) > 0.3) notes.push('Speed brake reduces roll authority');

    // gear handle interlock
    if (this.weightOnWheels && !S.gearDown) {
      S.gearDown = true;
      this.wowWarn = 3;
    }
    this.wowWarn = this.weightOnWheels ? Math.max(0, this.wowWarn - dt) : 0;
    if (this.wowWarn > 0) notes.push('Weight on wheels: gear handle locked down');

    // slow actuators: full travel takes 1 / rate seconds
    drive('gear', S.gearDown ? 1 : 0, 0.2);
    drive('canopy', S.canopyOpen ? 1 : 0, 0.15);
    drive('hook', S.hookDown ? 1 : 0, 1);
    drive('mainBay', S.mainBay ? 1 : 0, 0.8);
    drive('sideBay', S.sideBays ? 1 : 0, 0.8);
    drive('throttle', S.throttle, 0.7);
    drive('ab', S.afterburner, 1);

    if (S.canopyOpen && S.mach > 0.1 && !S.gearDown) notes.push('Canopy open in flight');
    if ((S.mainBay || S.sideBays) && S.mach > 1.6) notes.push('Bay doors open above Mach 1.6');
    this.info.notes = notes;
    this.apply(this.time);
  }

  /** Pose every moving part from `pos`. */
  apply(t) {
    const P = this.pos;
    const S = this.state;
    const deg = (v) => v * DEG;
    const [starboard, port] = this.wings;
    for (const [wing, sfx] of [[starboard, 'R'], [port, 'L']]) {
      wing.hinges.lef.userData.set(deg(-P.lef));
      wing.hinges.flaperon.userData.set(deg(P[`flaperon${sfx}`]));
      wing.hinges.aileron.userData.set(deg(P[`aileron${sfx}`]));
    }
    this.stabs[0].userData.set(deg(-P.stabR));
    this.stabs[1].userData.set(deg(-P.stabL));
    this.fins[0].rudder.userData.set(deg(P.rudderR));
    this.fins[1].rudder.userData.set(deg(-P.rudderL));
    this.noseGear.set(P.gear);
    this.mainGear.forEach((leg) => leg.set(P.gear));
    this.cockpit.canopyHinge.userData.set(deg(38) * sstep(0, 1, P.canopy));
    this.hook.rotation.z = deg(38) * sstep(0, 1, P.hook);
    this.bays.set(P.mainBay, P.sideBay);
    this.engines.update(P.throttle, P.ab, P.vector, t);

    // lights: steady position lights, a double-flash strobe every 1.2 s, taxi light with the gear down
    const on = S.lights;
    const phase = t % 1.2;
    const strobe = on && (phase < 0.06 || (phase > 0.16 && phase < 0.22));
    const M = this.mats;
    M.beacon.emissiveIntensity = strobe ? 8 : 0;
    M.lamp.emissiveIntensity = on && P.gear > 0.98 ? 3 : 0;
    M.formation.emissiveIntensity = on ? 0.9 : 0;
    M.navRed.emissiveIntensity = M.navGreen.emissiveIntensity = M.navWhite.emissiveIntensity = on ? 2 : 0;
  }
}

