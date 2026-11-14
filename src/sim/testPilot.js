/*
 * Scripted test pilot for batch runs. Flies the non-manual test cards the same way every time, so that
 * differences between runs come from the airframe or the conditions, not the pilot:
 *  - departure: brakes off, full power (reheat if fitted), runway-heading hold with rudder, rotate at Vr,
 *    fixed climb path, gear up at 50 ft, flaps up at 800 ft;
 *  - test-point: altitude hold with the stick, speed hold with the throttle (or full reheat to accelerate).
 */

const D2R = Math.PI / 180;
const KT = 1.94384;
const FT = 3.28084;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const wrap180 = (d) => ((d + 540) % 360) - 180;

export class TestPilot {
  constructor(physics, card, ctx) {
    this.p = physics;
    this.card = card;
    this.ctx = ctx;
    this.holdAltM = physics.pos.y;
    this.holdHeading = ctx.departure?.compass ?? physics.headingDeg;
    this.speedTarget = null;
    this.integ = 0;
    if (card.start === 'test-point') {
      const pt = card.point(ctx.aircraft);
      this.speedTarget = card.id === 'accel' ? null : pt;
    }
  }

  /** Stick input that asks for a given change in load factor (G) around the path-holding neutral. */
  pitchFor(dn) {
    const ac = this.p.ac;
    return dn >= 0 ? clamp(dn / (ac.nMax - 1), 0, 1) : clamp(dn / (1 - ac.nMin), -1, 0);
  }

  fly(dt) {
    const p = this.p;
    const c = p.controls;
    const ac = p.ac;
    const s = p.s;
    const att = { bank: s.bank / D2R };
    const hdgErr = wrap180(this.holdHeading - p.headingDeg);
    c.roll = clamp(-att.bank * 0.06, -1, 1);
    c.yaw = clamp(hdgErr * (s.onGround ? 0.25 : 0.4), -1, 1);
    if (this.card.start === 'departure') return this.departure(dt, hdgErr);
    return this.cruise(dt);
  }

  departure() {
    const p = this.p;
    const c = p.controls;
    const ac = p.ac;
    const s = p.s;
    c.parkingBrake = false;
    c.brakes = false;
    c.throttle = 1;
    if (ac.afterburner) c.afterburner = true;
    if (s.onGround) {
      c.pitch = p.airspeed * KT >= ac.vRotateKt ? 0.7 : 0;
      return;
    }
    const agl = s.agl * FT;
    if (ac.amphibious) {
      // stick centred: the flight computer holds height in ground effect
      c.pitch = 0;
      if (agl > 10 && p.config.gearDown) p.config.gearDown = false;
      return;
    }
    if (agl > 50 && p.config.gearDown) p.config.gearDown = false;
    if (agl > 800 && p.config.flaps !== 'up') p.config.flaps = 'up';
    const gammaDeg = Math.asin(clamp(p.vel.y / Math.max(p.vel.length(), 1), -1, 1)) / D2R;
    const want = ac.nMax > 5 ? 12 : 7;
    // ease the climb if speed decays towards the stall (engine out)
    const margin = clamp((p.airspeed * KT - ac.vRotateKt) / 20, 0, 1);
    c.pitch = this.pitchFor(clamp((want * margin - gammaDeg) * 0.05, -0.4, 0.4));
  }

  cruise(dt) {
    const p = this.p;
    const c = p.controls;
    const ac = p.ac;
    const s = p.s;
    if (ac.amphibious) {
      c.pitch = 0; // height hold
    } else {
      const err = this.holdAltM - p.pos.y;
      const vsWant = clamp(err * 0.08, -10, 10);
      c.pitch = this.pitchFor(clamp((vsWant - p.vel.y) * 0.04, -0.4, 0.4));
    }
    if (!this.speedTarget) {
      c.throttle = 1;
      if (ac.afterburner) c.afterburner = true;
      return;
    }
    const t = this.speedTarget;
    const err = t.kt ? (t.kt - p.airspeed * KT) / 100 : t.mach - s.mach;
    this.integ = clamp(this.integ + err * dt * 0.4, -0.5, 0.5);
    const cmd = clamp(c.throttle + (err * 2 + this.integ) * dt, 0, 1);
    c.throttle = cmd;
    if (ac.afterburner) c.afterburner = cmd > 0.99 && err > 0.005 ? true : c.afterburner && err > -0.01;
  }
}
