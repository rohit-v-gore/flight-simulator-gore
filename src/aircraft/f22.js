import { F22 } from '../f22/F22.js';

/** The procedural F-22 wrapped in the common aircraft contract (see CONTRACT.md). */
export function create(renderer) {
  const jet = new F22(renderer, { livery: 'raptor' });
  jet.update(0, true);
  return {
    id: 'f22',
    name: 'F-22 Raptor',
    root: jet.root,
    eye: [3.95, 3.2, 0],
    chaseDistance: 28,
    jet,
    update(dt, s) {
      Object.assign(jet.state, {
        mach: s.speed / 340,
        pitch: s.pitch,
        roll: s.roll,
        yaw: s.yaw,
        throttle: Math.max(0.15, s.throttle),
        afterburner: s.afterburner,
        gearDown: s.gearDown,
        flaps: s.flaps,
        speedBrake: s.speedBrake,
        mainBay: !!s.bays,
        sideBays: !!s.bays,
        thrustVectoring: s.vectoring !== false,
        canopyOpen: !!s.canopyOpen,
      });
      jet.weightOnWheels = s.onGround;
      jet.update(dt);
    },
  };
}
