import * as THREE from 'three';

/*
 * Flight data recorder. Samples the aircraft state at a fixed rate (default 10 Hz) into channels,
 * logs discrete events, and keeps running performance measurements (takeoff distances, touchdown,
 * extremes, fuel / energy, time in a height band). Pure JS: runs in the browser and in Node.
 */

const D2R = Math.PI / 180;
const KT = 1.94384;
const FT = 3.28084;
const FPM = FT * 60;

const fwd = new THREE.Vector3();
const upv = new THREE.Vector3();
const right = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Pitch and bank (degrees) from the physics orientation. Bank is positive right wing down. */
export function attitudeOf(physics) {
  fwd.set(1, 0, 0).applyQuaternion(physics.quat);
  upv.set(0, 1, 0).applyQuaternion(physics.quat);
  right.crossVectors(fwd, UP).normalize();
  return {
    pitch: Math.asin(Math.max(-1, Math.min(1, fwd.y))) / D2R,
    bank: Math.atan2(upv.dot(right), upv.y) / D2R,
  };
}

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Recorded channels: [name, unit, description, getter(physics, attitude)]. */
export const CHANNELS = [
  ['t', 's', 'Simulation time', (p) => r2(p.s.time)],
  ['x', 'm', 'Position east', (p) => r1(p.pos.x)],
  ['z', 'm', 'Position south', (p) => r1(p.pos.z)],
  ['alt', 'ft', 'Altitude above sea level', (p) => Math.round(p.pos.y * FT)],
  ['agl', 'ft', 'Height above the surface', (p) => Math.round((p.s.onGround ? 0 : p.s.agl) * FT)],
  ['ias', 'kt', 'Indicated airspeed (equivalent)', (p) => r1(p.airspeed * KT)],
  ['tas', 'kt', 'True airspeed', (p) => r1(p.trueAirspeed * KT)],
  ['gs', 'kt', 'Ground speed', (p) => r1(Math.hypot(p.vel.x, p.vel.z) * KT)],
  ['mach', '', 'Mach number', (p) => r3(p.s.mach)],
  ['vs', 'fpm', 'Vertical speed', (p) => Math.round((p.s.onGround ? 0 : p.vel.y) * FPM)],
  ['hdg', 'deg', 'Track (compass)', (p) => r1(p.headingDeg)],
  ['pitch', 'deg', 'Pitch attitude', (p, a) => r1(a.pitch)],
  ['bank', 'deg', 'Bank angle', (p, a) => r1(a.bank)],
  ['aoa', 'deg', 'Angle of attack', (p) => r1(p.s.alpha / D2R)],
  ['nz', 'g', 'Normal load factor', (p) => r2(p.s.nz)],
  ['throttle', '%', 'Throttle', (p) => Math.round(p.controls.throttle * 100)],
  ['ab', '', 'Afterburner lit', (p) => (p.ac.afterburner && p.controls.afterburner && p.controls.throttle > 0.95 ? 1 : 0)],
  ['thrust', 'kN', 'Net thrust', (p) => r1(p.s.thrust / 1000)],
  ['stick_pitch', '', 'Pitch input (-1 push .. 1 pull)', (p) => r2(p.controls.pitch)],
  ['stick_roll', '', 'Roll input', (p) => r2(p.controls.roll)],
  ['rudder', '', 'Rudder / steering input', (p) => r2(p.controls.yaw)],
  ['gear', '', 'Gear / foil down', (p) => (p.config.gearDown ? 1 : 0)],
  ['flaps', '', 'Flap setting (0 up, 1 takeoff, 2 landing)', (p) => ['up', 'takeoff', 'landing'].indexOf(p.config.flaps)],
  ['on_surface', '', 'On the ground / water', (p) => (p.s.onGround ? 1 : 0)],
  ['engines_failed', '', 'Failed engines', (p) => p.failed.engines],
  ['fuel', 'kg', 'Fuel burned', (p) => r1(p.s.fuelKg)],
  ['energy', 'kWh', 'Battery energy used', (p) => r2(p.s.energyKWh)],
  ['dist', 'nm', 'Distance flown', (p) => r3(p.s.distance / 1852)],
];

export class FlightRecorder {
  /**
   * @param physics GamePhysics
   * @param opts { rateHz, band: { kind: 'agl' | 'alt', lo, hi } (feet), runwayCompass, departure, landing }
   */
  constructor(physics, opts = {}) {
    this.physics = physics;
    this.rate = opts.rateHz ?? 10;
    this.band = opts.band || null;
    this.runwayCompass = opts.runwayCompass ?? null;
    this.landing = opts.landing || null; // { threshold: {x, y}, heading } of the runway end landed on
    this.samples = [];
    this.events = [];
    this.next = 0;
    this.listener = (ev) => this.onPhysicsEvent(ev);
    physics.listeners.push(this.listener);
    const p = physics;
    this.m = {
      startTime: p.s.time,
      startAltFt: p.pos.y * FT,
      brakeRelease: null,
      liftoff: null,
      screen35: null,
      climb1000: null,
      touchdown: null,
      stopped: null,
      crash: null,
      maxNz: p.s.onGround ? 1 : p.s.nz,
      minNz: p.s.onGround ? 1 : p.s.nz,
      maxMach: p.s.mach,
      maxIasKt: p.airspeed * KT,
      maxAltFt: p.pos.y * FT,
      maxAoA: 0,
      maxBank: 0,
      maxTrackDev: 0,
      bandIn: 0,
      bandTotal: 0,
      machSum: 0,
      machN: 0,
      failure: null,
    };
  }

  /** Stop listening to the physics (call when the run ends). */
  detach() {
    const l = this.physics.listeners;
    const i = l.indexOf(this.listener);
    if (i >= 0) l.splice(i, 1);
  }

  event(type, data = {}) {
    this.events.push({ t: Math.round(this.physics.s.time * 100) / 100, type, ...data });
  }

  /** Call once per frame after physics.step. Physics events arrive through the listener. */
  update(dt) {
    const p = this.physics;
    const s = p.s;
    const m = this.m;
    const att = attitudeOf(p);
    if (s.onGround && !m.brakeRelease && !m.liftoff && s.groundSpeed > 0.5) {
      m.brakeRelease = { t: s.time, x: p.pos.x, z: p.pos.z, dist: s.distance };
      this.event('brake_release');
    }
    if (m.liftoff && !m.screen35 && !s.onGround && s.agl * FT >= 35) {
      m.screen35 = { t: s.time, iasKt: p.airspeed * KT, dist: s.distance - (m.brakeRelease?.dist ?? 0) };
      this.event('screen_35ft', { dist_m: Math.round(m.screen35.dist) });
    }
    if (m.liftoff && !m.climb1000 && !s.onGround && s.agl * FT >= 1000) {
      m.climb1000 = { t: s.time, dist: s.distance - (m.brakeRelease?.dist ?? 0) };
      this.event('climb_1000ft_agl');
    }
    if (m.touchdown && !m.stopped && s.onGround && p.speed < 1) {
      m.stopped = { t: s.time, roll: s.distance - m.touchdown.dist };
      this.event('stopped', { landing_roll_m: Math.round(m.stopped.roll) });
    }
    if (!s.onGround) {
      m.maxNz = Math.max(m.maxNz, s.nz);
      m.minNz = Math.min(m.minNz, s.nz);
      m.maxAoA = Math.max(m.maxAoA, s.alpha / D2R);
      m.maxBank = Math.max(m.maxBank, Math.abs(att.bank));
      m.machSum += s.mach * dt;
      m.machN += dt;
    }
    m.maxMach = Math.max(m.maxMach, s.mach);
    m.maxIasKt = Math.max(m.maxIasKt, p.airspeed * KT);
    m.maxAltFt = Math.max(m.maxAltFt, p.pos.y * FT);
    if (this.runwayCompass != null && m.brakeRelease && !m.touchdown) {
      const dev = Math.abs(((p.headingDeg - this.runwayCompass + 540) % 360) - 180);
      m.maxTrackDev = Math.max(m.maxTrackDev, dev);
    }
    if (this.band && !s.onGround && dt > 0) {
      const v = this.band.kind === 'agl' ? s.agl * FT : p.pos.y * FT;
      m.bandTotal += dt;
      if (v >= this.band.lo && v <= this.band.hi) m.bandIn += dt;
    }
    if (s.time + 1e-9 >= this.next) {
      this.samples.push(CHANNELS.map((c) => c[3](p, att)));
      this.next = s.time + 1 / this.rate;
    }
  }

  onPhysicsEvent(ev) {
    const p = this.physics;
    const m = this.m;
    if (ev.type === 'liftoff' && !m.liftoff) {
      m.liftoff = { t: p.s.time, iasKt: (ev.ias ?? ev.speed) * KT, gsKt: ev.speed * KT, roll: p.s.distance - (m.brakeRelease?.dist ?? 0) };
      this.event('liftoff', { ias_kt: Math.round(m.liftoff.iasKt), ground_roll_m: Math.round(m.liftoff.roll) });
    }
    if (ev.type === 'touchdown' && !m.touchdown) {
      m.touchdown = {
        t: p.s.time,
        sinkFpm: ev.sink * FPM,
        gsKt: ev.speed * KT,
        iasKt: (ev.ias ?? ev.speed) * KT,
        crabDeg: ev.crabDeg ?? 0,
        quality: ev.quality,
        onRunway: ev.onRunway,
        onWater: ev.onWater,
        dist: p.s.distance,
        pastThreshold: this.pastThreshold(p.pos),
      };
      this.event('touchdown', { sink_fpm: Math.round(m.touchdown.sinkFpm), crab_deg: r1(m.touchdown.crabDeg), quality: ev.quality });
    }
    if (ev.type === 'crash' && !m.crash) {
      m.crash = { t: p.s.time, reason: ev.reason };
      this.event('crash', { reason: ev.reason });
    }
  }

  /** Distance (m) along the landing runway past its threshold, or null when not landing on a runway. */
  pastThreshold(pos) {
    const L = this.landing;
    if (!L) return null;
    return (pos.x - L.threshold.x) * Math.cos(L.heading) - (pos.z - L.threshold.y) * Math.sin(L.heading);
  }

  /** Summary numbers for the report (SI and aviation units, rounded). */
  summary() {
    const p = this.physics;
    const s = p.s;
    const m = this.m;
    const nm = s.distance / 1852;
    const out = {
      flight_time_s: Math.round(s.time - m.startTime),
      distance_nm: r2(nm),
      max_mach: r2(m.maxMach),
      max_ias_kt: Math.round(m.maxIasKt),
      max_alt_ft: Math.round(m.maxAltFt),
      max_g: r2(m.maxNz),
      min_g: r2(m.minNz),
      max_aoa_deg: r1(m.maxAoA),
      max_bank_deg: Math.round(m.maxBank),
      supersonic_over_land_s: r1(s.supersonicLandS),
    };
    if (p.ac.electric) {
      out.energy_kwh = r1(s.energyKWh);
      if (nm > 0.5) out.energy_kwh_per_nm = r2(s.energyKWh / nm);
    } else {
      out.fuel_kg = Math.round(s.fuelKg);
      if (nm > 0.5) out.fuel_kg_per_nm = r1(s.fuelKg / nm);
    }
    if (m.machN > 1) out.avg_mach_airborne = r3(m.machSum / m.machN);
    if (m.liftoff) {
      out.liftoff_ias_kt = Math.round(m.liftoff.iasKt);
      out.liftoff_time_s = r1(m.liftoff.t - (m.brakeRelease?.t ?? m.startTime));
      out.ground_roll_m = Math.round(m.liftoff.roll);
    }
    if (m.screen35) out.takeoff_distance_35ft_m = Math.round(m.screen35.dist);
    if (m.climb1000) out.time_to_1000ft_agl_s = r1(m.climb1000.t - (m.brakeRelease?.t ?? m.startTime));
    if (this.runwayCompass != null && m.brakeRelease) out.max_track_deviation_deg = r1(m.maxTrackDev);
    if (m.touchdown) {
      const td = m.touchdown;
      Object.assign(out, {
        touchdown_sink_fpm: Math.round(td.sinkFpm),
        touchdown_ias_kt: Math.round(td.iasKt),
        touchdown_crab_deg: r1(td.crabDeg),
        touchdown_quality: td.quality,
      });
      if (td.pastThreshold != null) out.touchdown_past_threshold_m = Math.round(td.pastThreshold);
    }
    if (m.stopped) out.landing_roll_m = Math.round(m.stopped.roll);
    if (this.band && m.bandTotal > 0) out.time_in_band_pct = Math.round((m.bandIn / m.bandTotal) * 100);
    if (m.failure) out.failure_at_ias_kt = Math.round(m.failure.iasKt);
    if (m.crash) out.crash = m.crash.reason;
    return out;
  }

  toCSV() {
    const head = CHANNELS.map((c) => (c[1] ? `${c[0]}_${c[1]}` : c[0])).join(',');
    return [head, ...this.samples.map((r) => r.join(','))].join('\n') + '\n';
  }

  /** Column-oriented series for charts: { t: [...], alt: [...], ... }. */
  series(names) {
    const idx = Object.fromEntries(CHANNELS.map((c, i) => [c[0], i]));
    return Object.fromEntries(names.map((n) => [n, this.samples.map((r) => r[idx[n]])]));
  }
}
