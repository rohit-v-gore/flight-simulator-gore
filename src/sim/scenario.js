import * as THREE from 'three';
import { AIRFRAMES, ENV_DEFAULTS, OVERRIDE_DEFAULTS } from '../game/physics.js';
import { FlightRecorder, CHANNELS } from './recorder.js';

/*
 * Sim Lab: test conditions, test cards with pass/fail criteria, and the run that grades a flight.
 * Shared by the browser game (src/game/main.js) and the headless runner (scripts/sim-run.mjs).
 *
 * A scenario is { aircraft, mode, card, from, to, cond } and serialises to JSON / a URL, so a test can be
 * re-flown exactly, shared with a colleague, or swept over a parameter range in batch.
 */

export const SIM_VERSION = '1.0';
const D2R = Math.PI / 180;
const KT = 1.94384;
const FT = 3.28084;
const FPM = FT * 60;

/* ---------------------------------- conditions ---------------------------------- */

/** Every knob a test engineer can set. Percentages are of the baseline airframe. */
export const DEFAULT_CONDITIONS = {
  ...ENV_DEFAULTS, // windKt, windFrom (compass, blowing from), gustKt, isaDevC
  ...OVERRIDE_DEFAULTS, // massPct, thrustPct, dragPct, clMaxPct
  failEngines: 0, // engines (motors) that fail
  failAtKt: 0, // airspeed that triggers the failure (0 = from the start)
};

/** Field metadata, for forms and validation: [key, label, unit, min, max, step]. */
export const CONDITION_FIELDS = [
  ['windKt', 'Wind speed', 'kt', 0, 60, 1],
  ['windFrom', 'Wind from', '°', 0, 359, 1],
  ['gustKt', 'Gusts ±', 'kt', 0, 30, 1],
  ['isaDevC', 'Temperature vs ISA', '°C', -40, 45, 1],
  ['massPct', 'Mass', '%', 60, 140, 1],
  ['thrustPct', 'Thrust', '%', 50, 150, 1],
  ['dragPct', 'Drag (zero-lift)', '%', 50, 200, 1],
  ['clMaxPct', 'Max lift (CLmax)', '%', 60, 140, 1],
  ['failEngines', 'Engines failed', '', 0, 8, 1],
  ['failAtKt', 'Failure at', 'kt', 0, 1500, 1],
];

export function normaliseConditions(c = {}) {
  const out = { ...DEFAULT_CONDITIONS };
  for (const [k, , , lo, hi] of CONDITION_FIELDS) {
    const v = Number(c[k]);
    if (Number.isFinite(v)) out[k] = Math.min(hi, Math.max(lo, v));
  }
  return out;
}

/** Configure physics for a run. Call after creating GamePhysics and before placing the aircraft. */
export function applyConditions(physics, type, cond) {
  const c = normaliseConditions(cond);
  physics.setType(type, { massPct: c.massPct, thrustPct: c.thrustPct, dragPct: c.dragPct, clMaxPct: c.clMaxPct });
  physics.env = { windKt: c.windKt, windFrom: c.windFrom, gustKt: c.gustKt, isaDevC: c.isaDevC };
  physics.failed.engines = 0;
  return c;
}

/** Changed conditions only, as short text: "wind 18 kt from 250°, ISA+25, mass 110%". */
export function describeConditions(c) {
  const d = [];
  if (c.windKt) d.push(`wind ${c.windKt} kt from ${String(c.windFrom).padStart(3, '0')}°`);
  if (c.gustKt) d.push(`gusts ±${c.gustKt} kt`);
  if (c.isaDevC) d.push(`ISA${c.isaDevC > 0 ? '+' : ''}${c.isaDevC}°C`);
  for (const [k, label] of [['massPct', 'mass'], ['thrustPct', 'thrust'], ['dragPct', 'drag'], ['clMaxPct', 'CLmax']]) if (c[k] !== 100) d.push(`${label} ${c[k]}%`);
  if (c.failEngines) d.push(`${c.failEngines} engine${c.failEngines > 1 ? 's' : ''} fail${c.failAtKt ? ` at ${c.failAtKt} kt` : ''}`);
  return d.length ? d.join(', ') : 'standard day, calm, baseline airframe';
}

/* ------------------------------------ routes ------------------------------------ */

const compassOf = (heading) => ((((90 - heading / D2R) % 360) + 360) % 360);

/** Departure / destination options: runway ends, or waterfront docks for the seaglider. */
export function placesFor(world, id) {
  if (AIRFRAMES[id].amphibious) {
    return world.docks.map((d) => ({ key: `dock:${d.city.code}`, label: `${d.city.name} waterfront`, dock: d }));
  }
  return world.ends.map((e) => ({ key: `rwy:${e.airport.city.code}:${e.number}`, label: `${e.airport.city.name} (${e.airport.city.code}) · runway ${e.number}`, end: e }));
}

export function destinationInfo(place) {
  if (place.end) {
    const e = place.end;
    return {
      name: `${e.airport.city.name} RWY ${e.number}`,
      gate: e.gate.clone(),
      touchdown: new THREE.Vector3(e.touchdown.x, e.airport.elev, e.touchdown.y),
      end: e,
      compass: compassOf(e.heading),
    };
  }
  // seaglider: a landing area 4 km off the dock, approached along the dock's heading
  const d = place.dock;
  const back = 4000;
  const gate = new THREE.Vector3(d.x - Math.cos(d.heading) * back, 9, d.z + Math.sin(d.heading) * back);
  return { name: d.name, gate, touchdown: new THREE.Vector3(d.x, 0, d.z), dock: d, compass: compassOf(d.heading) };
}

/** Start position on the runway (120 m past the threshold) or at the dock. Returns the departure context. */
export function placeAt(physics, place) {
  if (place.end) {
    const e = place.end;
    const along = 120;
    physics.reset({ x: e.threshold.x + Math.cos(e.heading) * along, z: e.threshold.y - Math.sin(e.heading) * along, heading: e.heading });
    return { label: place.label, compass: compassOf(e.heading), tora: e.airport.runway.length - 60 - along, elevFt: e.airport.elev * FT };
  }
  physics.reset({ x: place.dock.x, z: place.dock.z, heading: place.dock.heading });
  return { label: place.label, compass: compassOf(place.dock.heading), tora: null, elevFt: 0 };
}

/** Resolve a scenario's places, honouring a card's forced departure city. */
export function resolveRoute(world, setup, card) {
  const places = placesFor(world, setup.aircraft);
  let from = places.find((p) => p.key === setup.from) || places[0];
  if (card?.fromCity) from = places.find((p) => p.key.split(':')[1] === card.fromCity) || from;
  const to = places.find((p) => p.key === setup.to && p.key.split(':')[1] !== from.key.split(':')[1]) || places.find((p) => p.key.split(':')[1] !== from.key.split(':')[1]);
  return { places, from, to, dest: destinationInfo(to) };
}

/* ------------------------------------ helpers ------------------------------------ */

/** Throttle (and afterburner) for level unaccelerated flight at the current state. */
export function trimThrottle(physics) {
  const ac = physics.ac;
  const V = Math.max(physics.trueAirspeed, 1);
  const q = 0.5 * physics.rho() * V * V;
  physics.s.mach = V / physics.speedOfSound();
  const cl = (ac.mass * 9.80665) / (q * ac.wingArea);
  const drag = q * ac.wingArea * physics.dragCoefficient(cl, 1e4);
  const c = physics.controls;
  c.afterburner = false;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    c.throttle = (lo + hi) / 2;
    if (physics.thrustNow(1e4) > drag) hi = c.throttle;
    else lo = c.throttle;
  }
  c.throttle = hi;
  if (hi > 0.999 && ac.afterburner) c.afterburner = true;
  return { throttle: c.throttle, afterburner: c.afterburner, dragN: drag };
}

/** Throttle that holds the approach speed on a 3° glide path (gear and landing flap down). */
export function approachThrottle(physics, V) {
  const ac = physics.ac;
  const c = physics.controls;
  const rho = physics.rho();
  const cl = (ac.mass * 9.80665 * Math.cos(3 * D2R)) / (0.5 * rho * V * V * ac.wingArea);
  const need = 0.5 * rho * V * V * ac.wingArea * physics.dragCoefficient(cl) - ac.mass * 9.80665 * Math.sin(3 * D2R);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    c.throttle = (lo + hi) / 2;
    if (physics.thrustNow(500) > need) hi = c.throttle;
    else lo = c.throttle;
  }
  c.throttle = (lo + hi) / 2;
}

/** Airborne on final approach to the destination, configured to land. */
export function startOnFinal(physics, dest) {
  const ac = physics.ac;
  if (ac.amphibious) {
    const d = dest.dock;
    const x = d.x - Math.cos(d.heading) * 7000;
    const z = d.z + Math.sin(d.heading) * 7000;
    physics.startAirborne({ x, y: 9, z, heading: d.heading, speed: 40, gearDown: false, flaps: 'takeoff', throttle: 0.55 });
  } else {
    const g = dest.gate;
    const V = (ac.vApproachKt / KT) * 1.05;
    physics.startAirborne({ x: g.x, y: g.y, z: g.z, heading: dest.end.heading, speed: V, gearDown: true, flaps: 'landing', throttle: 0.3, path: -3 });
    approachThrottle(physics, V);
  }
}

/** Over-water test range for cruise and acceleration legs: west of the west coast, flying south. */
const RANGE = { x: -84000, z: -52000, heading: -Math.PI / 2 };

/** Cruise test points. Seaglider altitude is height above the water. */
export const CRUISE = {
  f22: { altFt: 30000, mach: 0.9, legNm: 20 },
  concorde: { altFt: 52000, mach: 2.0, legNm: 20 },
  airliner: { altFt: 35000, mach: 0.78, legNm: 20 },
  seaglider: { altFt: 30, kt: 130, legNm: 10 },
};
export const ACCEL = {
  f22: { altFt: 36000, mach0: 0.95, target: 1.6, limitS: 180 },
  concorde: { altFt: 45000, mach0: 0.95, target: 1.8, limitS: 360 },
};

/** Put the aircraft at a test point: altitude (ft), and Mach or knots. */
export function startAtTestPoint(physics, { altFt, mach, kt }) {
  const y = altFt / FT;
  const speed = kt ? kt / KT : mach * physics.speedOfSound(y);
  physics.startAirborne({ x: RANGE.x, y, z: RANGE.z, heading: RANGE.heading, speed, gearDown: false, flaps: 'up', throttle: 0.7 });
  trimThrottle(physics);
  return { label: 'Over-water test range, heading south', compass: 180, tora: null, elevFt: 0 };
}

/* ----------------------------------- test cards ----------------------------------- */

const wheeled = ['f22', 'concorde', 'airliner'];
const all = ['f22', 'concorde', 'airliner', 'seaglider'];
const fmt = (v, unit = '', d = 0) => (v == null || Number.isNaN(v) ? '—' : `${Number(v).toLocaleString(undefined, { maximumFractionDigits: d })}${unit ? ` ${unit}` : ''}`);
const crit = (label, test) => ({ label, test });

const noCrash = crit('No crash or departure from controlled flight', (m) => ({ ok: !m.crash, value: m.crash || 'none' }));

function takeoffCriteria(ac, ctx) {
  const list = [crit('Lift off', (m) => ({ ok: m.liftoff_ias_kt != null, value: m.liftoff_ias_kt != null ? `${m.liftoff_ias_kt} kt after ${fmt(m.ground_roll_m, 'm')}` : 'did not lift off' }))];
  if (ac.amphibious) {
    list.push(crit('Lift off within 3,000 m of water run', (m) => ({ ok: m.ground_roll_m != null && m.ground_roll_m <= 3000, value: fmt(m.ground_roll_m, 'm') })));
  } else {
    const tora = Math.round(ctx.departure.tora);
    list.push(crit(`Clear 35 ft within the runway available (${tora.toLocaleString()} m)`, (m) => ({ ok: m.takeoff_distance_35ft_m != null && m.takeoff_distance_35ft_m <= tora, value: fmt(m.takeoff_distance_35ft_m, 'm') })));
  }
  list.push(noCrash);
  return list;
}

function landingCriteria(ac, ctx) {
  const sinkLimit = Math.round((ac.maxTouchdownVS * 0.6 * FPM) / 10) * 10;
  const list = [
    crit(ac.amphibious ? 'Touch down on the water' : 'Touch down on the runway', (m, rec) => ({ ok: !!(ac.amphibious ? rec.m.touchdown?.onWater : rec.m.touchdown?.onRunway), value: m.touchdown_quality || 'no touchdown' })),
    crit(`Sink rate at touchdown ≤ ${sinkLimit} fpm`, (m) => ({ ok: m.touchdown_sink_fpm != null && m.touchdown_sink_fpm <= sinkLimit, value: fmt(m.touchdown_sink_fpm, 'fpm') })),
  ];
  if (!ac.amphibious) {
    const zone = ac.wheelbase > 15 ? 1200 : 900;
    list.push(crit('Crab at touchdown ≤ 5°', (m) => ({ ok: m.touchdown_crab_deg != null && Math.abs(m.touchdown_crab_deg) <= 5, value: fmt(m.touchdown_crab_deg, '°', 1) })));
    list.push(crit(`Touchdown zone: 150 to ${zone} m past the threshold`, (m) => ({ ok: m.touchdown_past_threshold_m != null && m.touchdown_past_threshold_m >= 150 && m.touchdown_past_threshold_m <= zone, value: fmt(m.touchdown_past_threshold_m, 'm') })));
  }
  list.push(crit('Brought to a stop', (m) => ({ ok: m.landing_roll_m != null && !m.crash, value: m.landing_roll_m != null ? `${fmt(m.landing_roll_m, 'm')} roll` : 'not stopped' })));
  list.push(noCrash);
  return list;
}

/**
 * Test cards. `start`: departure (on the runway / at the dock), final (on approach to the destination),
 * test-point (airborne on the over-water range). `end(run)` returns true when the card's data is complete.
 */
export const TEST_CARDS = [
  {
    id: 'takeoff',
    name: 'Takeoff performance',
    aircraft: all,
    start: 'departure',
    summary: 'Brake release to 1,500 ft AGL (seaglider: liftoff, then 30 s in ground effect). Measures ground roll, takeoff distance over a 35 ft screen, liftoff speed and fuel or energy used.',
    pilot: 'Full power (afterburner if fitted), rotate at Vr, climb out, gear up.',
    criteria: takeoffCriteria,
    end: (run) => (run.ac.amphibious ? run.rec.m.liftoff && run.physics.s.time - run.rec.m.liftoff.t > 30 : run.physics.s.agl * FT >= 1500 && !run.physics.s.onGround),
  },
  {
    id: 'engine-out',
    name: 'Engine failure at rotation',
    aircraft: all,
    start: 'departure',
    conditions: (ac) => ({ failEngines: ac.amphibious ? 2 : 1, failAtKt: Math.round(ac.vRotateKt * 0.95) }),
    summary: 'An engine (two motors on the seaglider) fails just before rotation. Continue the takeoff, keep straight with rudder against the asymmetric thrust, and climb to 1,000 ft AGL (seaglider: 45 s in ground effect).',
    pilot: 'Continue: full power on the remaining engines, rudder to stay on the runway heading, rotate, climb.',
    criteria: (ac, ctx) => [
      ...takeoffCriteria(ac, ctx).filter((c) => c !== noCrash),
      ac.amphibious
        ? crit('Hold 15 to 45 ft for 80% of the flight', (m) => ({ ok: (m.time_in_band_pct ?? 0) >= 80, value: fmt(m.time_in_band_pct, '%') }))
        : crit('Reach 1,000 ft AGL', (m) => ({ ok: m.time_to_1000ft_agl_s != null, value: m.time_to_1000ft_agl_s != null ? `${m.time_to_1000ft_agl_s} s after brake release` : 'not reached' })),
      crit('Track within 15° of the runway / departure heading', (m) => ({ ok: m.max_track_deviation_deg != null && m.max_track_deviation_deg <= 15, value: fmt(m.max_track_deviation_deg, '°', 1) })),
      noCrash,
    ],
    band: (ac) => (ac.amphibious ? { kind: 'agl', lo: 15, hi: 45 } : null),
    end: (run) => (run.ac.amphibious ? run.rec.m.liftoff && run.physics.s.time - run.rec.m.liftoff.t > 45 : run.physics.s.agl * FT >= 1000 && !run.physics.s.onGround),
  },
  {
    id: 'crosswind',
    name: 'Gusty crosswind landing',
    aircraft: all,
    start: 'final',
    conditions: (ac, ctx) => ({ windKt: ac.amphibious ? 10 : 18, gustKt: ac.amphibious ? 4 : 8, windFrom: Math.round((ctx.dest.compass + 90) % 360) }),
    summary: 'Start on final with a direct crosswind from the right and gusts. Fly the approach in a crab, kick it straight with rudder (A / D) just before touchdown, land in the touchdown zone (seaglider: on the water by the dock) and stop.',
    pilot: 'Hold the approach speed, crab into the wind, straighten with rudder in the flare, then brake to a stop.',
    manual: true,
    criteria: landingCriteria,
    end: (run) => !!run.rec.m.stopped,
  },
  {
    id: 'hot-high',
    name: 'Hot & high departure (Denver, ISA+25 °C)',
    aircraft: wheeled,
    start: 'departure',
    fromCity: 'DEN',
    conditions: () => ({ isaDevC: 25 }),
    summary: 'Denver sits at 5,250 ft. On a hot day (ISA+25 °C) the air is thinner: less lift, less thrust, longer takeoff. Brake release to 1,500 ft AGL.',
    pilot: 'Full power (afterburner if fitted), rotate at Vr, climb out, gear up.',
    criteria: takeoffCriteria,
    end: (run) => run.physics.s.agl * FT >= 1500 && !run.physics.s.onGround,
  },
  {
    id: 'cruise',
    name: 'Cruise efficiency',
    aircraft: all,
    start: 'test-point',
    point: (id) => CRUISE[id],
    summary: 'Level cruise leg over the ocean at the design cruise point (F-22 M0.9 at 30,000 ft; Concorde M2.0 at 52,000 ft; airliner M0.78 at 35,000 ft; seaglider 130 kt at 30 ft). Measures fuel or battery energy per nautical mile.',
    pilot: 'Hold altitude and the cruise speed for the whole leg.',
    band: (ac, id) => (ac.amphibious ? { kind: 'agl', lo: 15, hi: 45 } : { kind: 'alt', lo: CRUISE[id].altFt - 300, hi: CRUISE[id].altFt + 300 }),
    criteria: (ac, ctx) => [
      crit(`Fly the ${CRUISE[ctx.aircraft].legNm} nm leg`, (m) => ({ ok: m.distance_nm >= CRUISE[ctx.aircraft].legNm - 0.05, value: fmt(m.distance_nm, 'nm', 1) })),
      crit(ac.amphibious ? 'Hold 15 to 45 ft for 90% of the leg' : 'Hold altitude ±300 ft for 90% of the leg', (m) => ({ ok: (m.time_in_band_pct ?? 0) >= 90, value: fmt(m.time_in_band_pct, '%') })),
      crit('No supersonic flight over land (sonic boom)', (m) => ({ ok: m.supersonic_over_land_s === 0, value: `${m.supersonic_over_land_s} s` })),
      ac.electric
        ? crit('Report battery energy per nm', (m) => ({ ok: m.energy_kwh_per_nm != null, value: fmt(m.energy_kwh_per_nm, 'kWh/nm', 2) }))
        : crit('Report fuel burn per nm', (m) => ({ ok: m.fuel_kg_per_nm != null, value: fmt(m.fuel_kg_per_nm, 'kg/nm', 1) })),
      noCrash,
    ],
    end: (run) => run.physics.s.distance / 1852 >= CRUISE[run.aircraft].legNm,
  },
  {
    id: 'accel',
    name: 'Transonic acceleration',
    aircraft: ['f22', 'concorde'],
    start: 'test-point',
    point: (id) => ({ altFt: ACCEL[id].altFt, mach: ACCEL[id].mach0 }),
    summary: 'From Mach 0.95 at altitude, full reheat in level flight through the sound barrier to the target Mach (F-22 1.6 at 36,000 ft; Concorde 1.8 at 45,000 ft), over water. Measures time and fuel through the transonic drag rise.',
    pilot: 'Afterburner, hold altitude, accelerate.',
    criteria: (ac, ctx) => {
      const a = ACCEL[ctx.aircraft];
      return [
        crit(`Reach Mach ${a.target} within ${a.limitS} s`, (m, rec, run) => ({ ok: run.reached != null && run.reached <= a.limitS, value: run.reached != null ? `${run.reached.toFixed(0)} s` : `max M${m.max_mach}` })),
        crit('No supersonic flight over land (sonic boom)', (m) => ({ ok: m.supersonic_over_land_s === 0, value: `${m.supersonic_over_land_s} s` })),
        crit('Report fuel burned', (m) => ({ ok: m.fuel_kg != null, value: fmt(m.fuel_kg, 'kg') })),
        noCrash,
      ];
    },
    end: (run) => {
      const a = ACCEL[run.aircraft];
      if (run.reached == null && run.physics.s.mach >= a.target) run.reached = run.physics.s.time - run.rec.m.startTime;
      return run.reached != null || run.physics.s.time - run.rec.m.startTime > a.limitS * 1.5;
    },
  },
];

export const cardById = (id) => TEST_CARDS.find((c) => c.id === id) || null;
export const cardsFor = (aircraft) => TEST_CARDS.filter((c) => c.aircraft.includes(aircraft));

/** Conditions a card starts from (its defaults on top of the standard day). */
export function cardConditions(card, aircraft, world, setup = {}) {
  const ac = AIRFRAMES[aircraft];
  const { dest } = resolveRoute(world, { aircraft, ...setup }, card);
  return normaliseConditions({ ...DEFAULT_CONDITIONS, ...(card?.conditions?.(ac, { dest, aircraft }) || {}) });
}

/* ------------------------------------- the run ------------------------------------- */

/**
 * One graded flight. Owns the flight data recorder, fires scheduled failures, decides when the card is
 * complete, and builds the report.
 */
export class ScenarioRun {
  constructor({ physics, setup, card, ctx, cond }) {
    this.physics = physics;
    this.setup = setup;
    this.card = card;
    this.ctx = ctx; // { aircraft, departure, dest, startKind }
    this.cond = cond;
    this.aircraft = setup.aircraft;
    this.ac = physics.ac;
    this.reached = null;
    this.status = 'running';
    this.endReason = '';
    const landing = ctx.dest?.end && (setup.mode === 'landing' || card?.start === 'final') ? ctx.dest.end : null;
    this.rec = new FlightRecorder(physics, {
      band: card?.band?.(this.ac, this.aircraft) || (this.ac.amphibious ? { kind: 'agl', lo: 15, hi: 45 } : null),
      runwayCompass: ctx.startKind === 'departure' ? ctx.departure?.compass : null,
      landing: landing ? { threshold: landing.threshold, heading: landing.heading } : null,
    });
    this.criteria = card ? card.criteria(this.ac, ctx) : setup.mode === 'landing' ? landingCriteria(this.ac, ctx) : [];
    this.failArmed = cond.failEngines > 0;
    this.rec.event('start', { aircraft: this.aircraft, card: card?.id || setup.mode });
    if (this.failArmed && !cond.failAtKt) this.fail();
  }

  fail() {
    const p = this.physics;
    p.failed.engines = Math.min(this.cond.failEngines, p.ac.engines);
    this.rec.m.failure = { t: p.s.time, iasKt: p.airspeed * KT };
    this.rec.event('engine_failure', { engines: p.failed.engines, ias_kt: Math.round(p.airspeed * KT) });
    this.failArmed = false;
  }

  /** Call every frame after physics.step. Returns true once the run has ended. */
  update(dt) {
    if (this.status !== 'running') return true;
    const p = this.physics;
    if (this.failArmed && p.airspeed * KT >= this.cond.failAtKt) this.fail();
    this.rec.update(dt);
    if (p.s.crashed) return this.finish('crash', p.s.crashReason);
    if (this.card?.end(this)) return this.finish('complete', 'Test card complete');
    return false;
  }

  /** End the run (complete, crash, or ended by the user). */
  finish(status, reason = '') {
    if (this.status === 'running') {
      this.status = status;
      this.endReason = reason;
      this.rec.event('end', { status, reason });
      this.rec.detach();
    }
    return true;
  }

  report() {
    const metrics = this.rec.summary();
    const results = this.criteria.map((c) => {
      let r;
      try {
        r = c.test(metrics, this.rec, this);
      } catch {
        r = { ok: false, value: 'error' };
      }
      return { label: c.label, pass: !!r.ok, value: String(r.value ?? '') };
    });
    // crash: FAIL; card complete: PASS or FAIL; ended early by the user: PASS or INCOMPLETE; no criteria: RECORDED
    const allPass = results.every((r) => r.pass);
    let verdict;
    if (this.status === 'crash') verdict = results.length ? 'FAIL' : 'CRASH';
    else if (!results.length) verdict = 'RECORDED';
    else if (this.status === 'complete') verdict = allPass ? 'PASS' : 'FAIL';
    else verdict = allPass ? 'PASS' : 'INCOMPLETE';
    return {
      generator: `United Coast Sim Lab ${SIM_VERSION}`,
      generated: new Date().toISOString(),
      scenario: {
        aircraft: this.aircraft,
        airframe: AIRFRAMES[this.aircraft].name,
        mode: this.setup.mode,
        card: this.card ? { id: this.card.id, name: this.card.name } : null,
        departure: this.ctx.departure?.label || null,
        destination: this.ctx.dest?.name || null,
        conditions: this.cond,
        conditions_text: describeConditions(this.cond),
        link: encodeScenario(this.setup),
      },
      result: { verdict, status: this.status, reason: this.endReason },
      criteria: results,
      metrics,
      events: this.rec.events,
      channels: CHANNELS.map(([name, unit, description]) => ({ name, unit, description })),
      samples: this.rec.samples.length,
    };
  }
}

/** Set up the physics for a scenario and create its run. Shared by the game and the batch runner. */
export function prepareRun(physics, world, setup) {
  const card = setup.mode === 'test' ? cardById(setup.card) : null;
  const cond = applyConditions(physics, setup.aircraft, setup.cond || DEFAULT_CONDITIONS);
  const { from, dest } = resolveRoute(world, setup, card);
  const ctx = { aircraft: setup.aircraft, dest, departure: null, startKind: 'departure', from };
  if (card?.start === 'test-point') {
    ctx.departure = startAtTestPoint(physics, card.point(setup.aircraft));
    ctx.startKind = 'test-point';
  } else if (card?.start === 'final' || setup.mode === 'landing') {
    startOnFinal(physics, dest);
    ctx.startKind = 'final';
  } else {
    ctx.departure = placeAt(physics, from);
  }
  return { card, cond, ctx };
}

/* ------------------------------------ sharing ------------------------------------ */

/** Scenario → URL-safe string (base64 of compact JSON). */
export function encodeScenario(setup) {
  const json = JSON.stringify({ v: 1, aircraft: setup.aircraft, mode: setup.mode, card: setup.card || null, from: setup.from || null, to: setup.to || null, cond: setup.cond || DEFAULT_CONDITIONS });
  const b64 = typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(json))) : Buffer.from(json, 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeScenario(str) {
  try {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const json = typeof atob === 'function' ? decodeURIComponent(escape(atob(b64))) : Buffer.from(b64, 'base64').toString('utf8');
    return parseScenario(JSON.parse(json));
  } catch {
    return null;
  }
}

/** Validate a scenario object (from a link or a .json file). */
export function parseScenario(o) {
  const src = o?.scenario && !o.aircraft ? { ...o.scenario, card: o.scenario.card?.id ?? o.scenario.card, cond: o.scenario.conditions } : o;
  if (!src || !AIRFRAMES[src.aircraft]) return null;
  const mode = ['tutorial', 'free', 'landing', 'test'].includes(src.mode) ? src.mode : 'free';
  return { aircraft: src.aircraft, mode, card: src.card || null, from: src.from || null, to: src.to || null, cond: normaliseConditions(src.cond || src.conditions) };
}

export { FT, KT, FPM };
