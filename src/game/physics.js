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
  ram: 0, // supersonic intake ram recovery: thrust grows with Mach (low-bypass engines)
  geHeight: 1, // ground-effect strength multiplier
  maxNoseUp: 13 * D2R,
  clFlap: { up: 0, takeoff: 0, landing: 0 }, // lift added by flap camber at a given angle of attack
  engines: 2,
  asymYaw: 1, // yaw from asymmetric thrust when an engine fails
  tsfc: 0.6,
  tsfcAb: 0.6,
  electric: false,
  driveEff: 0.75,
};

/** Design / loading overrides a test engineer can apply, in percent of the baseline airframe. */
export const OVERRIDE_DEFAULTS = { massPct: 100, thrustPct: 100, dragPct: 100, clMaxPct: 100 };

/** Atmosphere and wind. Wind is given as the direction it blows FROM (compass degrees) at 10 m height. */
export const ENV_DEFAULTS = { windKt: 0, windFrom: 270, gustKt: 0, isaDevC: 0 };

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
    ram: 0.2,
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
    engines: 2,
    asymYaw: 0.3, // engines sit close to the centreline
    tsfc: 0.8, // fuel, lb per lbf of thrust per hour
    tsfcAb: 1.9,
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
    engines: 4,
    tsfc: 1.0,
    tsfcAb: 1.6,
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
    engines: 2,
    tsfc: 0.55,
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
    engines: 8,
    asymYaw: 0.6,
    electric: true,
    thrustPower: 740000, // W of propulsive power at full throttle: propeller thrust falls as speed rises
    driveEff: 0.74, // battery to thrust power: motor, controller and propeller
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

/** ISA temperature (K) at altitude h (m), up to the tropopause. */
function isaTemp(h) {
  return 288.15 - 0.0065 * Math.min(Math.max(h, 0), 11000);
}

/** Airframe with overrides applied. Rotation and approach speeds scale with sqrt(mass / CLmax). */
export function airframeWith(type, o = {}) {
  const base = AIRFRAMES[type];
  const m = (o.massPct ?? 100) / 100;
  const t = (o.thrustPct ?? 100) / 100;
  const d = (o.dragPct ?? 100) / 100;
  const c = (o.clMaxPct ?? 100) / 100;
  const v = Math.sqrt(m / c);
  const clMax = Object.fromEntries(Object.entries(base.clMax).map(([k2, x]) => [k2, x * c]));
  return {
    ...base,
    mass: base.mass * m,
    thrustMil: base.thrustMil * t,
    thrustMax: base.thrustMax * t,
    cd0: base.cd0 * d,
    waveK: base.waveK * d,
    clMax,
    vRotate: base.vRotate * v,
    vRotateKt: Math.round(base.vRotateKt * v),
    vApproachKt: Math.round(base.vApproachKt * v),
  };
}

export class GamePhysics {
  /**
   * @param {object} world { groundAt, surfaceHeight, surfaceAt, runwayAt, obstacleAt? }
   * @param {string} type key of AIRFRAMES
   */
  constructor(world, type = 'f22') {
    this.world = world;
    this.env = { ...ENV_DEFAULTS };
    this.failed = { engines: 0 };
    this.airVel = new THREE.Vector3();
    this.setType(type);
    this.controls = {};
    this.config = {};
    this.events = [];
    this.listeners = [];
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.reset({ x: 0, z: 0, heading: 0 });
  }

  setType(type, overrides = {}) {
    this.type = type;
    this.overrides = { ...OVERRIDE_DEFAULTS, ...overrides };
    this.ac = airframeWith(type, this.overrides);
  }

  /** Air density with the day's temperature deviation (same pressure altitude, warmer air is thinner). */
  rho(h = this.pos.y) {
    const T = isaTemp(h);
    return airDensity(h) * (T / (T + this.env.isaDevC));
  }

  speedOfSound(h = this.pos.y) {
    const T = isaTemp(h);
    return soundSpeed(h) * Math.sqrt((T + this.env.isaDevC) / T);
  }

  /** Wind velocity (m/s, the direction air moves) at height `agl`, with a log-law surface layer and gusts. */
  windAt(agl, t = this.s.time, out = new THREE.Vector3()) {
    const e = this.env;
    if (!e.windKt && !e.gustKt) return out.set(0, 0, 0);
    const toward = (e.windFrom + 180) * D2R; // compass bearing the air moves towards
    const shear = clamp((Math.max(agl, 0.5) / 10) ** 0.14, 0.55, 1.45);
    const gs = e.gustKt / 1.94384;
    const gLong = gs * (0.55 * Math.sin(0.37 * t + 1) + 0.3 * Math.sin(1.13 * t + 2) + 0.2 * Math.sin(2.9 * t + 0.4));
    const gLat = gs * 0.6 * (0.6 * Math.sin(0.51 * t + 3) + 0.4 * Math.sin(1.7 * t + 1.3));
    const gUp = gs * 0.25 * (0.6 * Math.sin(0.83 * t + 0.7) + 0.4 * Math.sin(2.3 * t + 2.1)) * clamp(agl / 30, 0, 1);
    const along = (e.windKt / 1.94384) * shear + gLong;
    const ax = Math.sin(toward);
    const az = -Math.cos(toward);
    return out.set(ax * along - az * gLat, gUp, az * along + ax * gLat);
  }

  /** Fraction of installed thrust still available after engine failures. */
  get engineFactor() {
    return Math.max(0, this.ac.engines - this.failed.engines) / this.ac.engines;
  }

  /** Yaw rate (rad/s, + = left) from asymmetric thrust: the failed engines are on the left. */
  asymmetricYaw() {
    if (!this.failed.engines || this.failed.engines >= this.ac.engines) return 0;
    const lost = this.failed.engines / this.ac.engines;
    return 5 * D2R * this.ac.asymYaw * lost * (0.2 + 0.8 * clamp(this.controls.throttle, 0, 1)) * (this.ac.engines <= 2 ? 1 : 0.6);
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
      ias: 0, // indicated (equivalent) airspeed, m/s: what the pilot flies by
      tas: 0, // true airspeed, m/s
      fuelKg: 0,
      energyKWh: 0,
      distance: 0,
      supersonicLandS: 0,
    };
    this.airVel.set(0, 0, 0);
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
    this.airVel.copy(this.vel).sub(this.windAt(y - this.surfaceY(x, z)));
    this.setAirspeed(this.airVel.length());
    this.updateAttitude();
  }

  /** Inertial speed (over the ground / water). */
  get speed() {
    return this.s.onGround ? this.s.groundSpeed : this.vel.length();
  }

  /** Indicated airspeed (equivalent airspeed, m/s): same at liftoff whatever the altitude or temperature. */
  get airspeed() {
    return this.s.ias;
  }

  /** True airspeed relative to the moving air (m/s): sets Mach, propeller power and energy use. */
  get trueAirspeed() {
    return this.s.tas;
  }

  setAirspeed(tas) {
    this.s.tas = tas;
    this.s.ias = tas * Math.sqrt(this.rho() / 1.225);
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
    if (ac.thrustPower) thrust = Math.min(thrust, (ac.thrustPower * clamp(c.throttle, 0, 1) * (ac.thrustMil / AIRFRAMES[this.type].thrustMil)) / Math.max(this.s.tas, 1));
    thrust *= Math.max(ac.lapseFloor, (this.rho() / 1.225) ** ac.lapseExp);
    thrust *= 1 + ac.ram * clamp(this.s.mach - 0.4, 0, 1.1) ** 2; // engine temperature limits cap the gain above ~M1.5
    thrust *= this.engineFactor;
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
      this.s.mach = this.s.tas / this.speedOfSound();
      const x0 = this.pos.x;
      const z0 = this.pos.z;
      if (this.s.onGround) this.surfaceStep(h);
      else this.airStep(h);
      this.account(h, Math.hypot(this.pos.x - x0, this.pos.z - z0));
      if (this.s.crashed) break;
    }
    this.updateAttitude();
  }

  /** Fuel / battery energy, distance flown, and supersonic time over land (sonic-boom exposure). */
  account(dt, dist) {
    const s = this.s;
    const ac = this.ac;
    s.distance += dist;
    if (ac.electric) {
      s.energyKWh += (s.thrust * Math.max(s.tas, 12)) / ac.driveEff * dt / 3.6e6;
    } else {
      const ab = ac.afterburner && this.controls.afterburner && this.controls.throttle > 0.95;
      s.fuelKg += (s.thrust * (ab ? ac.tsfcAb : ac.tsfc)) / G / 3600 * dt;
    }
    if (s.mach > 1 && this.world.groundAt(this.pos.x, this.pos.z) > 0.5) s.supersonicLandS += dt;
  }

  /** Rolling on wheels, or floating / foiling on the water. */
  surfaceStep(dt) {
    const ac = this.ac;
    const c = this.controls;
    const s = this.s;
    const rho = this.rho();
    const V = s.groundSpeed;
    const dir0 = new THREE.Vector3(Math.cos(s.heading), 0, -Math.sin(s.heading));
    const wind = this.windAt(3);
    const Va = Math.max(0, V - wind.dot(dir0)); // a headwind adds airspeed
    this.setAirspeed(Va);
    const q = 0.5 * rho * Va * Va;
    const thrust = this.thrustNow(0);
    s.thrust = thrust;
    const canRotate = s.ias > ac.vRotate * 0.9;
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
    s.heading += this.asymmetricYaw() * clamp(s.groundSpeed / 25, 0, 1) * dt;
    const dir = new THREE.Vector3(Math.cos(s.heading), 0, -Math.sin(s.heading));
    this.pos.addScaledVector(dir, s.groundSpeed * dt);
    this.pos.y = this.surfaceY(this.pos.x, this.pos.z) + (ac.amphibious && s.foilborne ? 1.4 * sstep(18, 26, s.groundSpeed) : 0);
    this.vel.copy(dir).multiplyScalar(s.groundSpeed);
    this.airVel.copy(dir).multiplyScalar(Va);
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
      this.airVel.copy(this.vel).sub(wind);
      this.pos.y += 0.05;
      this.emit({ type: 'liftoff', speed: V, ias: s.ias });
    }
  }

  airStep(dt) {
    const ac = this.ac;
    const c = this.controls;
    const s = this.s;
    const rho = this.rho();
    const agl = this.pos.y - this.surfaceY(this.pos.x, this.pos.z);
    const wind = this.windAt(agl);
    this.airVel.copy(this.vel).sub(wind);
    const V = Math.max(this.airVel.length(), 1);
    this.setAirspeed(V);
    const xw = this.airVel.clone().divideScalar(V);
    const q = 0.5 * rho * V * V;
    const authority = clamp(s.ias / (ac.vRotate * 0.9), 0.15, 1);

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
    // seaglider: with the stick centred, hold the height it was released at (kept within 16-40 ft)
    if (ac.heightHold) {
      if (Math.abs(c.pitch) > 0.05 || s.holdAgl == null) s.holdAgl = clamp(agl, 5, 12);
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

    // rudder: yaws the nose (up to 8°, enough to kick out a crosswind crab) and the flight path
    s.beta = toward(s.beta, -c.yaw * 8 * D2R, 20 * D2R * dt);
    this.vel.applyAxisAngle(UP, (-c.yaw * 4 * D2R * authority + this.asymmetricYaw()) * dt);

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
    // crab: where the nose points (air path + rudder sideslip) versus where the wheels are travelling
    const noseHdg = Math.atan2(-this.airVel.z, this.airVel.x) + s.beta;
    const track = Math.atan2(-this.vel.z, this.vel.x);
    const crabDeg = ((((noseHdg - track) / D2R + 540) % 360) - 180);
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
    if (!ac.amphibious && Math.abs(crabDeg) > 12) return this.crash(`Gear side-load: touched down in a ${Math.abs(crabDeg).toFixed(0)}° crab`);
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
    this.emit({ type: 'touchdown', quality, sink, speed: horizontal, ias: s.ias, crabDeg, runway: s.runway, onRunway: surface === 'runway', onWater: surface === 'water' });
  }

  /** Queue an event for the game and notify listeners (the flight data recorder) immediately. */
  emit(ev) {
    this.events.push(ev);
    for (const fn of this.listeners) fn(ev);
  }

  crash(reason) {
    this.s.crashed = true;
    this.s.crashReason = reason;
    this.vel.set(0, 0, 0);
    this.emit({ type: 'crash', reason });
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
      const av = this.airVel.lengthSq() > 1 ? this.airVel : this.vel;
      const V = av.length();
      if (V < 1) return;
      const xw = av.clone().divideScalar(V);
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
