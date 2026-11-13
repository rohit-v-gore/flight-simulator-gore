import * as THREE from 'three';

/*
 * Game flight model, in the local scene frame (metres, Y up).
 *
 * Airborne it is a "wind-axes" point mass, which is how the F-22's fly-by-wire feels to the pilot:
 *  - the stick's pitch axis commands load factor (G), not elevator angle; neutral stick holds 1 G
 *    (plus automatic turn compensation while banked), so the jet flies where it is pointed;
 *  - the roll axis commands roll rate; neutral stick holds the bank angle;
 *  - the pedals yaw the flight path slightly (mostly for runway alignment).
 * Lift, drag and thrust come from coefficient build-ups and ISA air density. The attitude used for
 * rendering is the flight path rotated up by the angle of attack needed for the commanded G.
 *
 * On the ground the jet rolls along its heading with friction, brakes and nose-wheel steering,
 * raises the nose above rotation speed and lifts off when the wing carries its weight.
 */

const G = 9.80665;
const D2R = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const toward = (x, target, step) => x + clamp(target - x, -step, step);

export const AIRFRAME = {
  mass: 27000, // kg
  wingArea: 78, // m²
  thrustMil: 140000, // N, both engines at military power
  thrustMax: 232000, // N, full afterburner
  idleThrust: 0.06, // fraction of military thrust at idle
  cd0: 0.02,
  cdGear: 0.022,
  cdFlaps: { up: 0, takeoff: 0.012, landing: 0.032 },
  cdSpeedBrake: 0.04,
  cdBays: 0.008,
  k: 0.17,
  clAlpha: 3.8, // per radian
  clMax: { up: 1.55, takeoff: 1.8, landing: 2.0 },
  clMaxVectoring: 0.5,
  alphaMax: 26 * D2R,
  nMax: 9,
  nMin: -3,
  rollRate: 220 * D2R,
  vRotate: 72, // m/s, about 140 kt
  wheelbase: 7.5,
  rolling: 0.025,
  brakeDecel: 5.5,
  maxTouchdownVS: 5.0, // m/s (~1000 fpm); above this the gear collapses
  maxTouchdownBank: 12 * D2R,
};

/** ISA air density (kg/m³) at altitude h (m). */
export function airDensity(h) {
  return 1.225 * Math.max(0.15, 1 - 2.2558e-5 * Math.max(0, h)) ** 4.2559;
}

export class GamePhysics {
  /**
   * @param {object} world  { groundAt(x, z) -> height, surfaceAt(x, z) -> 'runway'|'grass'|'water'|'rough', runwayAt(x, z) -> runway|null }
   */
  constructor(world) {
    this.world = world;
    this.ac = AIRFRAME;
    this.controls = { pitch: 0, roll: 0, yaw: 0, throttle: 0.3, afterburner: false, brakes: false, parkingBrake: true };
    this.config = { gearDown: true, flaps: 'takeoff', speedBrake: false, bays: false, vectoring: true };
    this.events = [];
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.reset({ x: 0, z: 0, heading: 0 });
  }

  /** Park on the ground at (x, z), nose pointing along `heading` (radians, 0 = +X, positive = left/north). */
  reset({ x, z, heading }) {
    this.pos.set(x, this.world.groundAt(x, z), z);
    this.vel.set(0, 0, 0);
    Object.assign(this.config, { gearDown: true, flaps: 'takeoff', speedBrake: false, bays: false });
    Object.assign(this.controls, { pitch: 0, roll: 0, yaw: 0, throttle: 0.3, afterburner: false, brakes: false, parkingBrake: true });
    this.s = {
      onGround: true,
      crashed: false,
      crashReason: '',
      heading, // ground track / heading on the ground
      groundSpeed: 0,
      noseUp: 0, // pitch attitude while rolling (rotation)
      bank: 0,
      alpha: 0,
      beta: 0,
      nz: 1,
      stall: false,
      thrust: 0,
      agl: 0,
      vs: 0,
      runway: null,
      time: 0,
    };
    this.acc = 0;
    this.updateAttitude();
  }

  /** Start airborne at a point with a velocity (m/s) along heading, level, gear/flaps as given. */
  startAirborne({ x, y, z, heading, speed, gearDown = false, flaps = 'up', throttle = 0.7, path = 0 }) {
    this.reset({ x, z, heading });
    this.pos.set(x, y, z);
    // `path` = flight-path angle in degrees (negative = descending)
    const g = path * D2R;
    this.vel.set(Math.cos(heading) * Math.cos(g), Math.sin(g), -Math.sin(heading) * Math.cos(g)).multiplyScalar(speed);
    Object.assign(this.s, { onGround: false, groundSpeed: 0 });
    Object.assign(this.config, { gearDown, flaps });
    Object.assign(this.controls, { throttle, parkingBrake: false });
    this.updateAttitude();
  }

  get speed() {
    return this.s.onGround ? this.s.groundSpeed : this.vel.length();
  }

  get altitude() {
    return this.pos.y;
  }

  /** Heading of travel in degrees, 0 = north (-Z), clockwise. */
  get headingDeg() {
    const h = this.s.onGround ? this.s.heading : Math.atan2(-this.vel.z, this.vel.x);
    // scene heading 0 = +X (east), positive towards -Z (north); compass = 90 - that
    return (((90 - h / D2R) % 360) + 360) % 360;
  }

  thrustNow() {
    const c = this.controls;
    const ac = this.ac;
    const dry = ac.thrustMil * (ac.idleThrust + (1 - ac.idleThrust) * clamp(c.throttle, 0, 1));
    const thrust = c.afterburner && c.throttle > 0.95 ? ac.thrustMax : dry;
    // thrust lapses with altitude as the air thins
    return thrust * Math.max(0.35, (airDensity(this.pos.y) / 1.225) ** 0.7);
  }

  step(dt) {
    if (this.s.crashed) return;
    this.acc += Math.min(dt, 0.1);
    const h = 1 / 120;
    while (this.acc >= h) {
      this.acc -= h;
      this.s.time += h;
      if (this.s.onGround) this.groundStep(h);
      else this.airStep(h);
      if (this.s.crashed) break;
    }
    this.updateAttitude();
  }

  dragCoefficient(cl) {
    const ac = this.ac;
    const c = this.config;
    return ac.cd0 + ac.k * cl * cl + (c.gearDown ? ac.cdGear : 0) + ac.cdFlaps[c.flaps] + (c.speedBrake ? ac.cdSpeedBrake : 0) + (c.bays ? ac.cdBays : 0);
  }

  groundStep(dt) {
    const ac = this.ac;
    const c = this.controls;
    const s = this.s;
    const rho = airDensity(this.pos.y);
    const V = s.groundSpeed;
    const q = 0.5 * rho * V * V;
    const thrust = this.thrustNow();
    s.thrust = thrust;
    // rotation: above ~90% of Vr the stick raises the nose (up to 13°)
    const canRotate = V > ac.vRotate * 0.9;
    const wantNose = canRotate && c.pitch > 0.05 ? 13 * D2R * c.pitch : 0;
    s.noseUp = toward(s.noseUp, wantNose, 4 * D2R * dt);
    const cl = Math.min(ac.clAlpha * (s.noseUp + 1.5 * D2R), ac.clMax[this.config.flaps]);
    const lift = q * ac.wingArea * cl;
    const drag = q * ac.wingArea * this.dragCoefficient(cl);
    const weightOnWheels = Math.max(0, ac.mass * G - lift);
    const surface = this.world.surfaceAt(this.pos.x, this.pos.z);
    const rough = surface === 'runway' ? 1 : 3; // grass is draggier
    let decel = (drag + ac.rolling * rough * weightOnWheels) / ac.mass;
    if (c.brakes || c.parkingBrake) decel += ac.brakeDecel * (weightOnWheels / (ac.mass * G));
    const accel = thrust / ac.mass - (V > 0.05 || thrust / ac.mass < decel ? decel : 0);
    s.groundSpeed = Math.max(0, V + accel * dt);
    if (c.parkingBrake && thrust < ac.thrustMil * 0.8) s.groundSpeed = Math.max(0, s.groundSpeed - 20 * dt);
    // nose-wheel steering, washing out with speed; a little rudder authority at high speed
    const steer = 40 * D2R * c.yaw * clamp(1 - V / 45, 0.06, 1);
    s.heading -= (s.groundSpeed * Math.tan(steer)) / ac.wheelbase * dt;
    const dir = new THREE.Vector3(Math.cos(s.heading), 0, -Math.sin(s.heading));
    this.pos.addScaledVector(dir, s.groundSpeed * dt);
    this.pos.y = this.world.groundAt(this.pos.x, this.pos.z);
    this.vel.copy(dir).multiplyScalar(s.groundSpeed);
    s.bank = 0;
    s.alpha = s.noseUp;
    s.nz = 1;
    s.vs = 0;
    s.agl = 0;
    s.runway = this.world.runwayAt(this.pos.x, this.pos.z);
    if (surface === 'water') return this.crash('Rolled into the water');
    if (surface === 'rough' && s.groundSpeed > 25) return this.crash('Ran off onto rough ground');
    // lift-off: the wing carries the weight
    if (lift > ac.mass * G * 1.02 && s.noseUp > 4 * D2R) {
      s.onGround = false;
      this.vel.copy(dir).multiplyScalar(V);
      this.vel.y = 1.5;
      this.pos.y += 0.05;
      s.bank = 0;
      this.events.push({ type: 'liftoff', speed: V });
    }
  }

  airStep(dt) {
    const ac = this.ac;
    const c = this.controls;
    const s = this.s;
    const rho = airDensity(this.pos.y);
    const V = Math.max(this.vel.length(), 1);
    const xw = this.vel.clone().divideScalar(V);
    const q = 0.5 * rho * V * V;
    const authority = clamp(V / 70, 0.15, 1);

    // bank: roll-rate command, holds when the stick is centred
    s.bank += c.roll * ac.rollRate * authority * dt;
    s.bank = ((s.bank + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

    // lift direction: perpendicular to the flight path, tilted by bank
    let up0 = UP.clone().addScaledVector(xw, -UP.dot(xw));
    if (up0.lengthSq() < 1e-6) up0.set(-xw.x, 0, -xw.z); // flying straight up/down
    up0.normalize();
    const right0 = new THREE.Vector3().crossVectors(xw, up0);
    const liftUp = up0.clone().multiplyScalar(Math.cos(s.bank)).addScaledVector(right0, Math.sin(s.bank));

    // load-factor command (G). Neutral stick holds the current flight path: it asks for exactly the
    // normal force that cancels gravity across the path (plus turn compensation while banked).
    const gamma = Math.asin(clamp(xw.y, -1, 1));
    const turnComp = Math.abs(s.bank) < 75 * D2R ? clamp(1 / Math.cos(s.bank), 1, 2.5) : 1;
    const neutral = Math.cos(gamma) * turnComp;
    const nzCmd = c.pitch >= 0 ? neutral + c.pitch * (ac.nMax - neutral) : neutral + c.pitch * (neutral - ac.nMin);
    const weight = ac.mass * G;
    const thrust = this.thrustNow();
    s.thrust = thrust;
    // the wing supplies what the tilted thrust line doesn't
    const clNeeded = (nzCmd * weight - thrust * Math.sin(s.alpha)) / Math.max(q * ac.wingArea, 1);
    const vectoringBonus = this.config.vectoring ? ac.clMaxVectoring * clamp(1 - V / 120, 0, 1) : 0;
    const clMax = ac.clMax[this.config.flaps] + vectoringBonus;
    const cl = clamp(clNeeded, -0.8, clMax);
    s.stall = clNeeded > clMax && c.pitch > -0.2;
    s.alpha = clamp(cl / ac.clAlpha, -10 * D2R, this.config.vectoring ? 60 * D2R : ac.alphaMax);
    const lift = q * ac.wingArea * cl;
    s.nz = (lift + thrust * Math.sin(s.alpha)) / weight;

    const drag = q * ac.wingArea * this.dragCoefficient(cl) + (s.stall ? q * ac.wingArea * 0.15 : 0);
    const force = new THREE.Vector3()
      .addScaledVector(liftUp, lift + thrust * Math.sin(s.alpha))
      .addScaledVector(xw, thrust * Math.cos(s.alpha) - drag)
      .addScaledVector(UP, -weight);
    this.vel.addScaledVector(force, dt / ac.mass);

    // rudder: yaws the flight path a little, shows as sideslip
    s.beta = toward(s.beta, -c.yaw * 6 * D2R, 20 * D2R * dt);
    this.vel.applyAxisAngle(UP, -c.yaw * 4 * D2R * authority * dt);

    this.pos.addScaledVector(this.vel, dt);
    const ground = this.world.groundAt(this.pos.x, this.pos.z);
    s.agl = this.pos.y - ground;
    s.vs = this.vel.y;
    s.runway = this.world.runwayAt(this.pos.x, this.pos.z);
    if (s.agl <= 0) this.touchdown(ground);
  }

  /** Wheels (or anything else) meet the surface: decide between a landing and a crash. */
  touchdown(ground) {
    const ac = this.ac;
    const s = this.s;
    const sink = -this.vel.y;
    const surface = this.world.surfaceAt(this.pos.x, this.pos.z);
    const pitchDeg = (Math.asin(clamp(this.vel.y / Math.max(this.vel.length(), 1), -1, 1)) + s.alpha) / D2R;
    this.pos.y = ground;
    if (surface === 'water') return this.crash('Ditched in the water');
    if (!this.config.gearDown) return this.crash('Landed with the gear up');
    if (sink > ac.maxTouchdownVS) return this.crash(`Hit too hard (${(sink * 196.85).toFixed(0)} ft/min sink)`);
    if (Math.abs(s.bank) > ac.maxTouchdownBank) return this.crash('Wingtip strike: wings not level');
    if (pitchDeg < -3) return this.crash('Nose gear first: nose too low');
    if (surface === 'rough') return this.crash('Touched down on rough ground');
    const horizontal = Math.hypot(this.vel.x, this.vel.z);
    s.onGround = true;
    s.heading = Math.atan2(-this.vel.z, this.vel.x);
    s.groundSpeed = horizontal;
    s.noseUp = clamp(pitchDeg * D2R, 0, 13 * D2R);
    s.bank = 0;
    this.vel.y = 0;
    const quality = sink < 1.6 ? 'Butter' : sink < 3.0 ? 'Smooth' : 'Firm';
    this.events.push({
      type: 'touchdown',
      quality,
      sink,
      speed: horizontal,
      runway: s.runway,
      onRunway: surface === 'runway',
    });
  }

  crash(reason) {
    this.s.crashed = true;
    this.s.crashReason = reason;
    this.vel.set(0, 0, 0);
    this.events.push({ type: 'crash', reason });
  }

  /** Orientation for rendering: flight path pitched up by alpha, rolled by bank, yawed by sideslip. */
  updateAttitude() {
    const s = this.s;
    let fwd;
    let up;
    if (s.onGround) {
      const dir = new THREE.Vector3(Math.cos(s.heading), 0, -Math.sin(s.heading));
      fwd = dir.clone().multiplyScalar(Math.cos(s.noseUp)).addScaledVector(UP, Math.sin(s.noseUp));
      up = UP.clone().multiplyScalar(Math.cos(s.noseUp)).addScaledVector(dir, -Math.sin(s.noseUp));
    } else {
      const V = this.vel.length();
      if (V < 1) return;
      const xw = this.vel.clone().divideScalar(V);
      let up0 = UP.clone().addScaledVector(xw, -UP.dot(xw));
      if (up0.lengthSq() < 1e-6) up0.set(-xw.x, 0, -xw.z);
      up0.normalize();
      const right0 = new THREE.Vector3().crossVectors(xw, up0);
      const liftUp = up0.multiplyScalar(Math.cos(s.bank)).addScaledVector(right0, Math.sin(s.bank));
      fwd = xw.clone().multiplyScalar(Math.cos(s.alpha)).addScaledVector(liftUp, Math.sin(s.alpha));
      up = liftUp.clone().multiplyScalar(Math.cos(s.alpha)).addScaledVector(xw, -Math.sin(s.alpha));
      if (s.beta) fwd.applyAxisAngle(up, s.beta);
    }
    const right = new THREE.Vector3().crossVectors(fwd, up);
    const m = new THREE.Matrix4().makeBasis(fwd, up, right);
    this.quat.setFromRotationMatrix(m);
  }
}
