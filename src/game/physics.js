import * as THREE from 'three';

/*
 * Game flight model, in the local scene frame (metres, Y up), shared by every aircraft type.
 *
 * Airborne it is a "wind-axes" point mass, flown the way modern fly-by-wire aircraft feel:
 *  - the stick's pitch axis commands load factor (G); neutral stick holds the current flight path
 *    (with automatic turn compensation while banked);
 *  - the roll axis commands roll rate; neutral stick holds the bank angle;
 *  - the pedals yaw the flight path slightly (for runway alignment).
 * Lift, drag and thrust come from coefficient build-ups with ISA density, transonic wave drag and
 * ground effect. The attitude used for rendering is the flight path pitched up by the angle of attack.
 *
 * Wheeled aircraft roll on runways with friction, brakes and nose-wheel steering. Amphibious aircraft
 * (the seaglider) float on the hull, rise onto a hydrofoil, and lift off in ground effect.
 */

const G = 9.80665;
const D2R = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const toward = (x, target, step) => x + clamp(target - x, -step, step);
const sstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Shared defaults, overridden per aircraft. */
const BASE = {
  idleThrust: 0.06,
  afterburner: false,
  vectoring: false,
  amphibious: false,
  cdSpeedBrake: 0.04,
  cdBays: 0,
  clMaxVectoring: 0,
  rolling: 0.025,
  maxTouchdownBank: 12 * D2R,
  lapseFloor: 0.35, // thrust fraction left in thin air
  lapseExp: 0.7,
  geHeight: 1, // ground-effect strength multiplier
  maxNoseUp: 13 * D2R,
  clFlap: { up: 0, takeoff: 0, landing: 0 }, // lift added by flap camber at a given angle of attack
};

/**
 * Airframe data (rounded, public-domain style figures). Speeds in m/s; `vRotateKt` / `vApproachKt`
 * are the numbers the tutorial and HUD tell the pilot.
 */
export const AIRFRAMES = {
  f22: {
    ...BASE,
    name: 'F-22 Raptor',
    mass: 27000,
    wingArea: 78,
    span: 13.56,
    thrustMil: 140000,
    thrustMax: 232000,
    afterburner: true,
    vectoring: true,
    cd0: 0.02,
    cdGear: 0.022,
    cdFlaps: { up: 0, takeoff: 0.012, landing: 0.032 },
    cdBays: 0.008,
    k: 0.17,
    clAlpha: 3.8,
    clMax: { up: 1.55, takeoff: 1.8, landing: 2.0 },
    clMaxVectoring: 0.5,
    clFlap: { up: 0, takeoff: 0.15, landing: 0.3 },
    lapseFloor: 0.45,
    alphaMax: 26 * D2R,
    nMax: 9,
    nMin: -3,
    rollRate: 220 * D2R,
    vRotate: 72,
    wheelbase: 7.5,
    brakeDecel: 5.5,
    maxTouchdownVS: 5.0,
    mcrit: 0.92,
    waveK: 0.025,
    vRotateKt: 140,
    vApproachKt: 150,
    climbFt: 3000,
    cruiseThrottle: 0.7,
  },
  concorde: {
    ...BASE,
    name: 'Concorde',
    mass: 120000,
    wingArea: 358,
    span: 25.6,
    thrustMil: 560000,
    thrustMax: 676000,
    afterburner: true,
    idleThrust: 0.05,
    cd0: 0.0125,
    cdGear: 0.015,
    cdFlaps: { up: 0, takeoff: 0.004, landing: 0.008 },
    k: 0.36,
    clAlpha: 2.4,
    clMax: { up: 1.05, takeoff: 1.2, landing: 1.3 },
    alphaMax: 18 * D2R,
    nMax: 2.5,
    nMin: -1,
    rollRate: 35 * D2R,
    vRotate: 100,
    wheelbase: 18,
    brakeDecel: 3.8,
    maxTouchdownVS: 3.5,
    lapseFloor: 0.5,
    lapseExp: 0.6,
    mcrit: 0.95,
    waveK: 0.012,
    maxNoseUp: 14 * D2R,
    vRotateKt: 195,
    vApproachKt: 165,
    climbFt: 5000,
    cruiseThrottle: 0.75,
  },
  airliner: {
    ...BASE,
    name: 'Airliner (A320-class)',
    mass: 64000,
    wingArea: 122.6,
    span: 35.8,
    thrustMil: 240000,
    thrustMax: 240000,
    idleThrust: 0.07,
    cd0: 0.022,
    cdGear: 0.02,
    cdFlaps: { up: 0, takeoff: 0.015, landing: 0.045 },
    cdSpeedBrake: 0.03,
    k: 0.045,
    clAlpha: 5.3,
    clMax: { up: 1.45, takeoff: 2.1, landing: 2.7 },
    clFlap: { up: 0, takeoff: 0.55, landing: 0.95 },
    alphaMax: 16 * D2R,
    nMax: 2.5,
    nMin: -1,
    rollRate: 40 * D2R,
    vRotate: 75,
    wheelbase: 12.6,
    brakeDecel: 3.5,
    maxTouchdownVS: 3.2,
    mcrit: 0.8,
    waveK: 0.25,
    maxNoseUp: 12 * D2R,
    vRotateKt: 145,
    vApproachKt: 138,
    climbFt: 5000,
    cruiseThrottle: 0.8,
  },
  seaglider: {
    ...BASE,
    name: 'Seaglider (electric WIG)',
    mass: 7200,
    wingArea: 55,
    span: 20,
    thrustMil: 17000,
    thrustMax: 17000,
    idleThrust: 0,
    amphibious: true,
    cd0: 0.034,
    cdGear: 0.01, // hydrofoil drag in the air
    cdFlaps: { up: 0, takeoff: 0.02, landing: 0.04 },
    k: 0.055,
    clAlpha: 4.8,
    clMax: { up: 1.4, takeoff: 1.9, landing: 2.2 },
    clFlap: { up: 0, takeoff: 0.3, landing: 0.55 },
    alphaMax: 14 * D2R,
    nMax: 2.0,
    nMin: -0.5,
    rollRate: 30 * D2R,
    vRotate: 32,
    wheelbase: 8,
    brakeDecel: 1.5,
    maxTouchdownVS: 2.5,
    maxTouchdownBank: 8 * D2R,
    lapseFloor: 1,
    mcrit: 0.6,
    waveK: 0.05,
    geHeight: 1.6,
    maxNoseUp: 9 * D2R,
    vRotateKt: 70,
    vApproachKt: 70,
    climbFt: 30,
    cruiseThrottle: 0.55,
    maxAglFt: 50,
    heightHold: true, // flight computer holds height over the water when the stick is centred
  },
};

/** ISA speed of sound (m/s) at altitude h (m): falls with temperature up to the tropopause. */
export function soundSpeed(h) {
  return 340.3 - 0.0041 * Math.min(Math.max(h, 0), 11000);
}

/** ISA air density (kg/m³) at altitude h (m). */
export function airDensity(h) {
  return 1.225 * Math.max(0.15, 1 - 2.2558e-5 * Math.max(0, h)) ** 4.2559;
}

export class GamePhysics {
  /**
   * @param {object} world { groundAt, surfaceHeight, surfaceAt, runwayAt, obstacleAt? }
   * @param {string} type key of AIRFRAMES
   */
  constructor(world, type = 'f22') {
    this.world = world;
    this.setType(type);
    this.controls = {};
    this.config = {};
    this.events = [];
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.reset({ x: 0, z: 0, heading: 0 });
  }

  setType(type) {
    this.type = type;
    this.ac = AIRFRAMES[type];
  }

  surfaceY(x, z) {
    return this.world.surfaceHeight ? this.world.surfaceHeight(x, z) : this.world.groundAt(x, z);
  }

  /** Stationary at (x, z), nose along `heading` (radians, 0 = +X/east, positive towards north). */
  reset({ x, z, heading }) {
    this.pos.set(x, this.surfaceY(x, z), z);
    this.vel.set(0, 0, 0);
    Object.assign(this.config, { gearDown: true, flaps: 'takeoff', speedBrake: false, bays: false, vectoring: this.ac.vectoring });
    Object.assign(this.controls, { pitch: 0, roll: 0, yaw: 0, throttle: this.ac.amphibious ? 0 : 0.3, afterburner: false, brakes: false, parkingBrake: !this.ac.amphibious });
    this.s = {
      onGround: true,
      onWater: this.ac.amphibious,
      crashed: false,
      crashReason: '',
      heading,
      groundSpeed: 0,
      noseUp: 0,
      bank: 0,
      alpha: 0,
      beta: 0,
      nz: 1,
      stall: false,
      thrust: 0,
      agl: 0,
      vs: 0,
      mach: 0,
      runway: null,
      foilborne: false,
      time: 0,
    };
    this.acc = 0;
    this.updateAttitude();
  }

  /** Airborne at a point, with flight-path angle `path` (deg, negative = descending). */
  startAirborne({ x, y, z, heading, speed, gearDown = false, flaps = 'up', throttle = 0.7, path = 0 }) {
    this.reset({ x, z, heading });
    const g = path * D2R;
    this.pos.set(x, y, z);
    this.vel.set(Math.cos(heading) * Math.cos(g), Math.sin(g), -Math.sin(heading) * Math.cos(g)).multiplyScalar(speed);
    Object.assign(this.s, { onGround: false, onWater: false, groundSpeed: 0 });
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

  /** Compass heading of travel (degrees, 0 = north / -Z, clockwise). */
  get headingDeg() {
    const h = this.s.onGround ? this.s.heading : Math.atan2(-this.vel.z, this.vel.x);
    return (((90 - h / D2R) % 360) + 360) % 360;
  }

  thrustNow(agl = 0) {
    const c = this.controls;
    const ac = this.ac;
    const dry = ac.thrustMil * (ac.idleThrust + (1 - ac.idleThrust) * clamp(c.throttle, 0, 1));
    let thrust = ac.afterburner && c.afterburner && c.throttle > 0.95 ? ac.thrustMax : dry;
    thrust *= Math.max(ac.lapseFloor, (airDensity(this.pos.y) / 1.225) ** ac.lapseExp);
    // a WIG craft is certified to stay in ground effect: power is limited above its height band
    if (ac.maxAglFt) thrust *= 1 - 0.5 * sstep(ac.maxAglFt * 0.3048, ac.maxAglFt * 0.3048 * 3, agl);
    return thrust;
  }

  /** Drag coefficient: parasite + induced (reduced in ground effect) + configuration + wave drag. */
  dragCoefficient(cl, agl = 1e4) {
    const ac = this.ac;
    const c = this.config;
    const h = Math.max(agl, 0.5) / (ac.span * ac.geHeight);
    const ge = (16 * h) ** 2 / (1 + (16 * h) ** 2);
    const M = this.s.mach;
    let wave = 0;
    if (M > ac.mcrit) {
      const peak = Math.max(ac.mcrit + 0.12, 1.05);
      wave = M < peak ? ac.waveK * ((M - ac.mcrit) / (peak - ac.mcrit)) ** 2 : ac.waveK * (peak / M) ** 1.5;
    }
    return ac.cd0 + ac.k * cl * cl * ge + (c.gearDown ? ac.cdGear : 0) + ac.cdFlaps[c.flaps] + (c.speedBrake ? ac.cdSpeedBrake : 0) + (c.bays ? ac.cdBays : 0) + wave;
  }

  step(dt) {
    if (this.s.crashed) return;
    this.acc += Math.min(dt, 0.1);
    const h = 1 / 120;
    while (this.acc >= h) {
      this.acc -= h;
      this.s.time += h;
      this.s.mach = this.speed / soundSpeed(this.pos.y);
      if (this.s.onGround) this.surfaceStep(h);
      else this.airStep(h);
      if (this.s.crashed) break;
    }
    this.updateAttitude();
  }

  /** Rolling on wheels, or floating / foiling on the water. */
  surfaceStep(dt) {
    const ac = this.ac;
    const c = this.controls;
    const s = this.s;
    const rho = airDensity(this.pos.y);
    const V = s.groundSpeed;
    const q = 0.5 * rho * V * V;
    const thrust = this.thrustNow(0);
    s.thrust = thrust;
    const canRotate = V > ac.vRotate * 0.9;
    const wantNose = canRotate && c.pitch > 0.05 ? ac.maxNoseUp * c.pitch : 0;
    s.noseUp = toward(s.noseUp, wantNose, 4 * D2R * dt);
    const surfaceGE = ac.amphibious ? 1.3 : 1; // strong ground effect right on the water
    const clMax = ac.clMax[this.config.flaps] * surfaceGE;
    const cl = Math.min((ac.clAlpha * (s.noseUp + 1.5 * D2R) + ac.clFlap[this.config.flaps]) * surfaceGE, clMax);
    const lift = q * ac.wingArea * cl;
    const drag = q * ac.wingArea * this.dragCoefficient(cl, 0.5);
    const load = Math.max(0, ac.mass * G - lift);
    const surface = this.world.surfaceAt(this.pos.x, this.pos.z);
    let resist;
    if (ac.amphibious) {
      // water resistance: displacement hull, the "hump" before planing, then much less once foilborne
      const foil = this.config.gearDown;
      const hump = 0.05 + 0.1 * sstep(4, 14, V) * (1 - sstep(16, 24, V));
      const after = foil ? 0.035 : 0.075;
      const mu = V < 16 ? hump : after + (hump - after) * (1 - sstep(16, 24, V));
      s.foilborne = foil && V > 18;
      resist = drag + mu * load + (c.brakes ? ac.brakeDecel * ac.mass * 0.3 : 0);
    } else {
      const rough = surface === 'runway' ? 1 : 3;
      resist = drag + ac.rolling * rough * load + (c.brakes || c.parkingBrake ? ac.brakeDecel * ac.mass * (load / (ac.mass * G)) : 0);
    }
    const accel = (thrust - (V > 0.05 || thrust < resist ? resist : 0)) / ac.mass;
    s.groundSpeed = Math.max(0, V + accel * dt);
    if (c.parkingBrake && thrust < ac.thrustMil * 0.8) s.groundSpeed = Math.max(0, s.groundSpeed - 20 * dt);
    const steerMax = ac.amphibious ? 12 * D2R : 40 * D2R;
    const steer = steerMax * c.yaw * clamp(1 - V / 45, ac.amphibious ? 0.3 : 0.06, 1);
    s.heading -= (s.groundSpeed * Math.tan(steer)) / ac.wheelbase * dt;
    const dir = new THREE.Vector3(Math.cos(s.heading), 0, -Math.sin(s.heading));
    this.pos.addScaledVector(dir, s.groundSpeed * dt);
    this.pos.y = this.surfaceY(this.pos.x, this.pos.z) + (ac.amphibious && s.foilborne ? 1.4 * sstep(18, 26, s.groundSpeed) : 0);
    this.vel.copy(dir).multiplyScalar(s.groundSpeed);
    s.bank = 0;
    s.alpha = s.noseUp;
    s.nz = 1;
    s.vs = 0;
    s.agl = 0;
    s.runway = this.world.runwayAt(this.pos.x, this.pos.z);
    if (ac.amphibious) {
      s.onWater = surface === 'water';
      if (!s.onWater && s.groundSpeed > 2) return this.crash('Ran aground: the seaglider operates on water');
    } else {
      if (surface === 'water') return this.crash('Rolled into the water');
      if (surface === 'city') return this.crash('Ran off into the city');
      if (surface === 'rough' && s.groundSpeed > 25) return this.crash('Ran off onto rough ground');
    }
    if (this.hitObstacle()) return;
    const minNose = ac.amphibious ? 1.5 * D2R : Math.min(4 * D2R, ac.maxNoseUp * 0.5);
    if (lift > ac.mass * G * 1.02 && s.noseUp > minNose) {
      s.onGround = false;
      s.onWater = false;
      this.vel.copy(dir).multiplyScalar(V);
      this.vel.y = 1.2;
      this.pos.y += 0.05;
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
    const authority = clamp(V / (ac.vRotate * 0.9), 0.15, 1);
    const agl = this.pos.y - this.surfaceY(this.pos.x, this.pos.z);

    s.bank += c.roll * ac.rollRate * authority * dt;
    s.bank = (((s.bank + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

    let up0 = UP.clone().addScaledVector(xw, -UP.dot(xw));
    if (up0.lengthSq() < 1e-6) up0.set(-xw.x, 0, -xw.z);
    up0.normalize();
    const right0 = new THREE.Vector3().crossVectors(xw, up0);
    const liftUp = up0.clone().multiplyScalar(Math.cos(s.bank)).addScaledVector(right0, Math.sin(s.bank));

    // neutral stick holds the flight path; pull/push asks for more/less G
    const gamma = Math.asin(clamp(xw.y, -1, 1));
    const turnComp = Math.abs(s.bank) < 75 * D2R ? clamp(1 / Math.cos(s.bank), 1, 2.5) : 1;
    const neutral = Math.cos(gamma) * turnComp;
    let nzCmd = c.pitch >= 0 ? neutral + c.pitch * (ac.nMax - neutral) : neutral + c.pitch * (neutral - ac.nMin);
    // seaglider: with the stick centred, hold the height it was released at (kept within 10-40 ft)
    if (ac.heightHold) {
      if (Math.abs(c.pitch) > 0.05 || s.holdAgl == null) s.holdAgl = clamp(agl, 3, 12);
      if (Math.abs(c.pitch) <= 0.05) {
        const vsWant = clamp((s.holdAgl - agl) * 0.6, -2, 2);
        nzCmd = clamp(neutral + (vsWant - this.vel.y) * 0.25, 0.3, 1.8);
      }
    }
    const weight = ac.mass * G;
    const thrust = this.thrustNow(agl);
    s.thrust = thrust;
    const geLift = 1 + 0.35 * (1 - sstep(0, ac.span * ac.geHeight, agl)); // more lift close to the surface
    const vectoringBonus = this.config.vectoring && ac.vectoring ? ac.clMaxVectoring * clamp(1 - V / 120, 0, 1) : 0;
    const clMax = ac.clMax[this.config.flaps] * geLift + vectoringBonus;
    const clNeeded = (nzCmd * weight - thrust * Math.sin(s.alpha)) / Math.max(q * ac.wingArea, 1);
    const cl = clamp(clNeeded, -0.8, clMax);
    s.stall = clNeeded > clMax && c.pitch > -0.2;
    s.alpha = clamp((cl - ac.clFlap[this.config.flaps]) / (ac.clAlpha * geLift), -10 * D2R, this.config.vectoring && ac.vectoring ? 60 * D2R : ac.alphaMax);
    const lift = q * ac.wingArea * cl;
    s.nz = (lift + thrust * Math.sin(s.alpha)) / weight;

    const drag = q * ac.wingArea * this.dragCoefficient(cl, agl) + (s.stall ? q * ac.wingArea * 0.15 : 0);
    const force = new THREE.Vector3()
      .addScaledVector(liftUp, lift + thrust * Math.sin(s.alpha))
      .addScaledVector(xw, thrust * Math.cos(s.alpha) - drag)
      .addScaledVector(UP, -weight);
    this.vel.addScaledVector(force, dt / ac.mass);

    s.beta = toward(s.beta, -c.yaw * 6 * D2R, 20 * D2R * dt);
    this.vel.applyAxisAngle(UP, -c.yaw * 4 * D2R * authority * dt);

    this.pos.addScaledVector(this.vel, dt);
    const ground = this.surfaceY(this.pos.x, this.pos.z);
    s.agl = this.pos.y - ground;
    s.vs = this.vel.y;
    s.runway = this.world.runwayAt(this.pos.x, this.pos.z);
    if (this.hitObstacle()) return;
    if (s.agl <= 0) this.touchdown(ground);
  }

  hitObstacle() {
    if (!this.world.obstacleAt) return false;
    const hit = this.world.obstacleAt(this.pos.x, this.pos.y + 1, this.pos.z);
    if (hit) this.crash(`Hit ${hit}`);
    return !!hit;
  }

  /** Something meets the surface: decide between a landing and a crash. */
  touchdown(ground) {
    const ac = this.ac;
    const s = this.s;
    const sink = -this.vel.y;
    const surface = this.world.surfaceAt(this.pos.x, this.pos.z);
    const pitchDeg = (Math.asin(clamp(this.vel.y / Math.max(this.vel.length(), 1), -1, 1)) + s.alpha) / D2R;
    this.pos.y = ground;
    if (ac.amphibious) {
      if (surface !== 'water') return this.crash('Hit land: the seaglider lands on water');
    } else {
      if (surface === 'water') return this.crash('Ditched in the water');
      if (surface === 'city') return this.crash('Crashed into the city');
      if (!this.config.gearDown) return this.crash('Landed with the gear up');
    }
    if (sink > ac.maxTouchdownVS) return this.crash(`Hit too hard (${(sink * 196.85).toFixed(0)} ft/min sink)`);
    if (Math.abs(s.bank) > ac.maxTouchdownBank) return this.crash('Wingtip strike: wings not level');
    if (pitchDeg < -3) return this.crash('Nose first: nose too low');
    if (!ac.amphibious && surface === 'rough') return this.crash('Touched down on rough ground');
    const horizontal = Math.hypot(this.vel.x, this.vel.z);
    s.onGround = true;
    s.onWater = ac.amphibious;
    s.heading = Math.atan2(-this.vel.z, this.vel.x);
    s.groundSpeed = horizontal;
    s.noseUp = clamp(pitchDeg * D2R, 0, ac.maxNoseUp);
    s.bank = 0;
    this.vel.y = 0;
    const quality = sink < ac.maxTouchdownVS * 0.32 ? 'Butter' : sink < ac.maxTouchdownVS * 0.6 ? 'Smooth' : 'Firm';
    this.events.push({ type: 'touchdown', quality, sink, speed: horizontal, runway: s.runway, onRunway: surface === 'runway', onWater: surface === 'water' });
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
      const up0 = UP.clone().addScaledVector(xw, -UP.dot(xw));
      if (up0.lengthSq() < 1e-6) up0.set(-xw.x, 0, -xw.z);
      up0.normalize();
      const right0 = new THREE.Vector3().crossVectors(xw, up0);
      const liftUp = up0.multiplyScalar(Math.cos(s.bank)).addScaledVector(right0, Math.sin(s.bank));
      fwd = xw.clone().multiplyScalar(Math.cos(s.alpha)).addScaledVector(liftUp, Math.sin(s.alpha));
      up = liftUp.clone().multiplyScalar(Math.cos(s.alpha)).addScaledVector(xw, -Math.sin(s.alpha));
      if (s.beta) fwd.applyAxisAngle(up, s.beta);
    }
    const right = new THREE.Vector3().crossVectors(fwd, up);
    this.quat.setFromRotationMatrix(new THREE.Matrix4().makeBasis(fwd, up, right));
  }
}
