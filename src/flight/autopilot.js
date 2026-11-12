import { D2R, clamp, bearingTo, distanceTo, travel } from './flightModel.js';

const G = 9.80665;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * A runway as a centre point, true heading (radians) and size. Supplies a local frame:
 * x along the runway (in the heading direction), y to the right of the centreline, metres.
 */
export class Runway {
  constructor({ name, lat, lon, heading, length, width, elevation }) {
    Object.assign(this, { name, lat: lat * D2R, lon: lon * D2R, heading: heading * D2R, length, width, elevation });
  }
  /** Geodetic point (radians) at runway-frame coordinates. */
  point(x, y) {
    const [la, lo] = travel(this.lat, this.lon, this.heading, x);
    return travel(la, lo, this.heading + Math.PI / 2, y);
  }
  /** Runway-frame coordinates of a geodetic point (flat-earth, fine within a few tens of km). */
  local(lat, lon) {
    const north = (lat - this.lat) * 6378137;
    const east = (lon - this.lon) * 6378137 * Math.cos(this.lat);
    const c = Math.cos(this.heading);
    const s = Math.sin(this.heading);
    return { x: north * c + east * s, y: -north * s + east * c };
  }
  contains(lat, lon, margin = 30) {
    const p = this.local(lat, lon);
    return Math.abs(p.x) < this.length / 2 + 300 && Math.abs(p.y) < this.width / 2 + margin;
  }
}

/** Edwards AFB, California — main runway 04R/22L on the edge of Rogers Dry Lake. */
export const EDWARDS = new Runway({
  name: '04R/22L',
  lat: 34.9054,
  lon: -117.8837,
  heading: 57.5,
  length: 4579,
  width: 91,
  elevation: 690,
});

/*
 * Demo sortie, in the runway frame (x along 04R, y right of it), heights above the field:
 * take off on 04R, swing out over the lakebed, a slow high-alpha pass with the nozzles working,
 * a fast low pass with the weapons bays open, then around to land on 22L.
 */
// `mode` applies to the leg flown *towards* that waypoint; `say` is announced when the leg starts.
const ROUTE = [
  { x: 9000, y: 0, agl: 900, speed: 200, say: 'Climbing out over Rogers Dry Lake' },
  { x: 13000, y: -7000, agl: 1200, speed: 180 },
  { x: 9000, y: -12000, agl: 450, speed: 85, say: 'Slowing down for the high-alpha pass' },
  { x: -4000, y: -12000, agl: 450, speed: 62, mode: 'alpha', say: 'High-alpha pass: nose up, thrust vectoring' },
  { x: -14000, y: -4000, agl: 900, speed: 200, say: 'Turning for the weapons-bay pass' },
  { x: -10000, y: 7000, agl: 300, speed: 240 },
  { x: 4000, y: 7000, agl: 300, speed: 240, mode: 'bays', say: 'Low pass, weapons bays open' },
  { x: 14000, y: 9000, agl: 900, speed: 170, say: 'Setting up for 22L' },
  { x: 22000, y: 1500, agl: 800, speed: 140 },
];

/**
 * Scripted pilot: sets the flight model's controls and configuration each step.
 * Phases: hold → takeoff → climb → route → final → flare → rollout → parked → done.
 */
export class DemoPilot {
  constructor(fm, runway, { say = () => {} } = {}) {
    Object.assign(this, { fm, rw: runway, say });
    this.restart();
  }

  restart() {
    const rw = this.rw;
    const [lat, lon] = rw.point(-rw.length / 2 + 120, 0);
    this.fm.reset({ lat, lon, h: rw.elevation, heading: rw.heading });
    Object.assign(this.fm.config, { gearDown: true, flaps: 'takeoff', speedBrake: false, bays: false, vectoring: true });
    Object.assign(this.fm.controls, { pitch: 0, roll: 0, yaw: 0, throttle: 0.3, afterburner: false, brakes: true });
    this.phase = 'hold';
    this.t = 0;
    this.wp = 0;
    this.mode = '';
    this.canopy = false;
    this.done = false;
    this.say(`Edwards AFB, runway 04R: afterburner takeoff`);
  }

  setPhase(p, msg) {
    this.phase = p;
    this.t = 0;
    if (msg) this.say(msg);
  }

  /* --------------------------- inner loops --------------------------- */

  holdSpeed(target, allowAB = true) {
    const c = this.fm.controls;
    const err = target - this.fm.s.V;
    c.throttle = clamp(0.55 + err * 0.06, 0, 1);
    // at high alpha the drag is huge: light the burners as soon as speed starts to bleed
    c.afterburner = allowAB && err > (this.mode === 'alpha' ? -3 : 12);
    this.fm.config.speedBrake = err < -25;
  }

  /** Fly a flight-path angle (radians) with the stick, compensating for bank. */
  holdGamma(gammaCmd, gain = 1.6) {
    const s = this.fm.s;
    const ac = this.fm.ac;
    const V = Math.max(s.V, 30);
    const n = Math.cos(s.gamma) / Math.max(Math.cos(s.phi), 0.3) + ((gammaCmd - s.gamma) * V * gain) / G;
    this.fm.controls.pitch = n >= 1 ? clamp((n - 1) / (ac.nMax - 1), 0, 1) : clamp((n - 1) / (1 - ac.nMin), -1, 0);
  }

  holdAltitude(h, maxClimb = 0.25) {
    const s = this.fm.s;
    this.holdGamma(clamp((h - s.h) / (Math.max(s.V, 60) * 10), -0.2, maxClimb));
  }

  /** Turn to a heading (radians) with a bank-angle limit. */
  holdHeading(psi, maxBank = 60 * D2R) {
    const s = this.fm.s;
    const bank = clamp(wrap(psi - s.psi) * 2.4, -maxBank, maxBank);
    this.fm.controls.roll = clamp((bank - s.phi) * 2.8, -1, 1);
  }

  /* ------------------------------ phases ------------------------------ */

  update(dt) {
    const { fm, rw } = this;
    const s = fm.s;
    const c = fm.controls;
    const cfg = fm.config;
    this.t += dt;
    if (s.crashed) return;
    const fieldH = rw.elevation;

    switch (this.phase) {
      case 'hold':
        c.brakes = true;
        c.throttle = 1;
        c.afterburner = this.t > 1.5;
        if (this.t > 3) this.setPhase('takeoff');
        break;
      case 'takeoff': {
        c.brakes = false;
        c.throttle = 1;
        c.afterburner = true;
        const p = rw.local(s.lat, s.lon);
        c.yaw = clamp(wrap(rw.heading - s.psi) * 4 - p.y * 0.05, -1, 1);
        c.pitch = s.V > fm.ac.vRotate ? 1 : 0;
        if (!s.onGround) {
          c.yaw = 0;
          this.setPhase('climb', 'Airborne');
        }
        break;
      }
      case 'climb':
        this.holdGamma(12 * D2R);
        this.holdHeading(rw.heading);
        c.afterburner = s.agl < 600;
        c.throttle = 1;
        if (s.agl > 15) cfg.gearDown = false;
        if (s.agl > 150) cfg.flaps = 'up';
        if (s.agl > 500) this.setPhase('route', ROUTE[0].say);
        break;
      case 'route': {
        const w = ROUTE[this.wp];
        const [la, lo] = rw.point(w.x, w.y);
        const dist = distanceTo(s.lat, s.lon, la, lo);
        this.mode = w.mode || '';
        cfg.bays = this.mode === 'bays';
        cfg.vectoring = true;
        const maxBank = this.mode === 'alpha' ? 25 * D2R : 65 * D2R;
        this.holdHeading(bearingTo(s.lat, s.lon, la, lo), maxBank);
        this.holdAltitude(fieldH + w.agl, 0.3);
        this.holdSpeed(w.speed);
        // capture radius grows with the turn radius so fast legs don't orbit their waypoint
        const turnR = (s.V * s.V) / (G * Math.tan(maxBank));
        if (dist < Math.max(1200, 1.3 * turnR)) {
          this.wp++;
          if (this.wp >= ROUTE.length) {
            this.mode = '';
            cfg.bays = false;
            this.setPhase('final', 'On final for 22L: gear down, full flaps');
          } else if (ROUTE[this.wp].say) this.say(ROUTE[this.wp].say);
        }
        break;
      }
      case 'final': {
        // land on 22L: the reciprocal of the 04R frame
        const p = rw.local(s.lat, s.lon);
        const hdg = rw.heading + Math.PI;
        const tdx = rw.length / 2 - 450; // touchdown point, runway-frame x
        const toGo = p.x - tdx;
        cfg.gearDown = true;
        cfg.flaps = toGo < 12000 ? 'landing' : 'takeoff';
        this.holdHeading(hdg + clamp(p.y * 0.0035, -0.5, 0.5), 30 * D2R);
        const glide = 3 * D2R;
        const gsH = fieldH + Math.max(toGo, 0) * Math.tan(glide);
        this.holdGamma(-glide + clamp((gsH - s.h) * 0.006, -0.06, 0.06), 1.2);
        this.holdSpeed(toGo > 8000 ? 110 : 75, false);
        if (s.agl < 9 && toGo < 1500) this.setPhase('flare', 'Flare');
        break;
      }
      case 'flare': {
        const p = rw.local(s.lat, s.lon);
        this.holdHeading(rw.heading + Math.PI + clamp(p.y * 0.004, -0.2, 0.2), 8 * D2R);
        c.throttle = Math.max(0, c.throttle - dt * 0.4);
        c.afterburner = false;
        this.holdGamma(-Math.max(0.5, Math.min(3, s.agl * 0.35)) * D2R, 1.4);
        if (s.onGround) this.setPhase('rollout', 'Touchdown');
        break;
      }
      case 'rollout': {
        const p = rw.local(s.lat, s.lon);
        c.roll = 0;
        c.pitch = 0;
        c.throttle = 0;
        c.afterburner = false;
        cfg.speedBrake = true;
        c.brakes = this.t > 1.5;
        c.yaw = clamp(wrap(rw.heading + Math.PI - s.psi) * 4 + p.y * 0.05, -1, 1);
        if (s.V < 0.5) {
          cfg.speedBrake = false;
          this.setPhase('parked', 'Stopped. Canopy coming up');
        }
        break;
      }
      case 'parked':
        c.brakes = true;
        c.yaw = 0;
        cfg.flaps = 'up';
        this.canopy = this.t > 2;
        if (this.t > 12) this.done = true;
        break;
      default:
        break;
    }
  }
}
