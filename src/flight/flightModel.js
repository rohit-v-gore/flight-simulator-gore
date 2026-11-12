/*
 * A compact F-22-class flight model for the globe view.
 *
 * Point mass flying in wind axes (speed V, flight-path angle gamma, heading psi) plus a bank angle.
 * The stick commands load factor and roll rate; lift, drag and thrust come from simple coefficient
 * build-ups with ISA density. On the ground the jet rolls along the surface with rolling friction,
 * brakes and nose-wheel steering, rotates above Vr and lifts off when lift exceeds weight.
 * Integration uses a fixed 1/120 s step regardless of the frame rate.
 *
 * Position is geodetic (radians) with `h` = ellipsoid height of the wheel-contact point.
 */

const G = 9.80665;
const EARTH_R = 6378137;
const D2R = Math.PI / 180;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const toward = (x, target, maxStep) => x + clamp(target - x, -maxStep, maxStep);

/** Airframe and engine data: F-22-like, rounded. */
export const AIRFRAME = {
  mass: 29000, // kg, combat weight
  wingArea: 78.0, // m²
  thrustMil: 2 * 70000, // N, two F119s at military power
  thrustMax: 2 * 116000, // N, full afterburner
  cd0: 0.019,
  cdGear: 0.02,
  cdFlaps: { up: 0, takeoff: 0.012, landing: 0.03 },
  cdSpeedBrake: 0.035,
  cdBays: 0.008,
  k: 0.17, // induced drag factor, 1 / (pi e AR)
  clAlpha: 3.6, // per radian
  clMax: { up: 1.6, takeoff: 1.85, landing: 2.0 },
  clMaxVectoring: 0.45, // extra usable lift with thrust vectoring (post-stall authority)
  nMax: 9,
  nMin: -3,
  rollRate: 240 * D2R,
  vRotate: 68, // m/s (~132 kt)
  mu: 0.025,
  brakeDecel: 4.5,
};

/** ISA density (kg/m³) at geometric height h (m). */
export function airDensity(h) {
  const t = Math.max(0.2, 1 - 2.2558e-5 * Math.max(0, h));
  return 1.225 * t ** 4.2559;
}

export class FlightModel {
  /**
   * @param {object} o
   * @param {(lat: number, lon: number) => number} o.groundHeight ellipsoid height of the surface
   */
  constructor({ groundHeight }) {
    this.groundHeight = groundHeight;
    this.ac = AIRFRAME;
    this.controls = { pitch: 0, roll: 0, yaw: 0, throttle: 0.2, afterburner: false, brakes: true };
    this.config = { gearDown: true, flaps: 'takeoff', speedBrake: false, bays: false, vectoring: true };
    this.events = [];
    this.reset({ lat: 0, lon: 0, h: 0, heading: 0 });
  }

  /** Place the jet stationary on the ground. */
  reset({ lat, lon, h, heading }) {
    this.s = {
      lat, lon, h,
      V: 0, gamma: 0, psi: heading, phi: 0,
      alpha: 0, theta: 0, n: 1,
      onGround: true, crashed: false,
      agl: 0, vs: 0, thrust: 0,
    };
    this.config.gearDown = true;
    this.accum = 0;
  }

  get mach() {
    return this.s.V / 340;
  }

  /** Advance by dt seconds (sub-stepped at 120 Hz). */
  step(dt) {
    const h = 1 / 120;
    this.accum += Math.min(dt, 0.25);
    while (this.accum >= h) {
      this.accum -= h;
      this.integrate(h);
    }
  }

  forces(rho) {
    const { ac, config, controls, s } = this;
    const q = 0.5 * rho * s.V * s.V;
    const thrustFrac = controls.afterburner ? 1 : clamp(controls.throttle, 0, 1) * (ac.thrustMil / ac.thrustMax);
    const thrust = ac.thrustMax * thrustFrac * clamp(rho / 1.225, 0.25, 1) ** 0.7;
    const cd0 = ac.cd0 + (config.gearDown ? ac.cdGear : 0) + ac.cdFlaps[config.flaps] + (config.speedBrake ? ac.cdSpeedBrake : 0) + (config.bays ? ac.cdBays : 0);
    return { q, thrust, cd0 };
  }

  integrate(dt) {
    const { ac, controls, config, s } = this;
    if (s.crashed) return;
    const rho = airDensity(s.h);
    const { q, thrust, cd0 } = this.forces(rho);
    const W = ac.mass * G;
    const ground = this.groundHeight(s.lat, s.lon);
    s.thrust = thrust;
    if (s.onGround) config.gearDown = true; // weight on wheels: the gear cannot retract

    if (s.onGround) {
      // rotation: pitch the nose up with back stick once fast enough
      const canRotate = s.V > ac.vRotate * 0.92;
      const thetaTarget = canRotate ? clamp(controls.pitch, 0, 1) * 13 * D2R : 0;
      s.theta = toward(s.theta, thetaTarget, 5 * D2R * dt);
      s.alpha = s.theta;
      const cl = ac.clAlpha * s.alpha + (config.flaps === 'up' ? 0 : 0.25);
      const lift = q * ac.wingArea * cl;
      const drag = q * ac.wingArea * (cd0 + ac.k * cl * cl);
      const normal = Math.max(0, W - lift);
      let decel = ac.mu * normal / ac.mass + drag / ac.mass;
      if (controls.brakes) decel += ac.brakeDecel * (normal / W);
      s.V = Math.max(0, s.V + (thrust / ac.mass - decel) * dt);
      if (s.V < 0.05 && thrust < 0.2 * ac.thrustMil) s.V = 0;
      // nose-wheel steering, fading out with speed
      const steer = controls.yaw * clamp(s.V / 8, 0, 1) * clamp(30 / Math.max(s.V, 1), 0.08, 1) * 0.5;
      s.psi += steer * dt;
      s.phi = toward(s.phi, 0, 0.5 * dt);
      s.gamma = 0;
      s.n = 1;
      s.h = ground;
      if (lift > W * 1.02 && s.V > ac.vRotate) {
        s.onGround = false;
        s.gamma = 0.5 * D2R;
        this.events.push('liftoff');
      }
    } else {
      // load factor from the stick, limited by structure and by available lift
      const clMax = ac.clMax[config.flaps] + (config.vectoring ? ac.clMaxVectoring : 0);
      const nAero = (q * ac.wingArea * clMax) / W;
      const nCmd = controls.pitch >= 0 ? 1 + controls.pitch * (ac.nMax - 1) : 1 + controls.pitch * (1 - ac.nMin);
      s.n = clamp(nCmd, Math.max(ac.nMin, -nAero), Math.min(ac.nMax, nAero));
      const cl = (s.n * W) / Math.max(q * ac.wingArea, 1);
      s.alpha = cl / ac.clAlpha - (config.flaps === 'up' ? 0 : 0.06);
      const drag = q * ac.wingArea * (cd0 + ac.k * cl * cl);
      const V = Math.max(s.V, 25);
      s.V = Math.max(25, s.V + ((thrust * Math.cos(s.alpha) - drag) / ac.mass - G * Math.sin(s.gamma)) * dt);
      s.phi += clamp(controls.roll, -1, 1) * ac.rollRate * clamp(q / 9000, 0.25, 1) * dt;
      s.phi = Math.atan2(Math.sin(s.phi), Math.cos(s.phi));
      s.gamma += (G / V) * (s.n * Math.cos(s.phi) - Math.cos(s.gamma)) * dt;
      s.gamma = clamp(s.gamma, -1.45, 1.45);
      s.psi += ((G / V) * s.n * Math.sin(s.phi)) / Math.max(Math.cos(s.gamma), 0.1) * dt + controls.yaw * 0.06 * dt;
      s.theta = s.gamma + s.alpha * Math.cos(s.phi);
    }
    s.psi = (s.psi + 2 * Math.PI) % (2 * Math.PI);

    // move over the ellipsoid
    const horiz = s.V * Math.cos(s.gamma) * dt;
    const R = EARTH_R + s.h;
    s.lat += (horiz * Math.cos(s.psi)) / R;
    s.lon += (horiz * Math.sin(s.psi)) / (R * Math.cos(s.lat));
    const climb = s.V * Math.sin(s.gamma);
    s.vs = s.onGround ? 0 : climb;
    if (!s.onGround) s.h += climb * dt;

    // touchdown or impact
    const g2 = this.groundHeight(s.lat, s.lon);
    s.agl = s.h - g2;
    if (!s.onGround && s.agl <= 0) {
      const sink = -climb;
      const ok = config.gearDown && sink < 6 && Math.abs(s.phi) < 15 * D2R && s.theta > -3 * D2R;
      if (ok) {
        s.onGround = true;
        s.h = g2;
        s.gamma = 0;
        s.phi = 0;
        this.events.push('touchdown');
      } else {
        s.crashed = true;
        s.h = g2;
        this.events.push('crash');
      }
    }
  }
}

/* ------------------------------ navigation helpers ------------------------------ */

/** Initial great-circle bearing from point 1 to point 2 (radians, clockwise from north). */
export function bearingTo(lat1, lon1, lat2, lon2) {
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return Math.atan2(y, x);
}

/** Great-circle distance in metres. */
export function distanceTo(lat1, lon1, lat2, lon2) {
  const a = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Point reached from (lat, lon) after `dist` metres on bearing `brg` (radians). */
export function travel(lat, lon, brg, dist) {
  const d = dist / EARTH_R;
  const lat2 = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(brg));
  const lon2 = lon + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(lat2));
  return [lat2, lon2];
}

export { D2R, clamp };
