import * as THREE from 'three';

/*
 * The interactive tutorial. Each step shows instructions and completes when its `done` check passes
 * (or, for `info` steps, when the player presses Enter). ctx = { physics, homeEnd, lakeEnd, jet }.
 */

const KT = 1.94384;
const FT = 3.28084;
const k = (key) => `<kbd>${key}</kbd>`;

const bearingTo = (p, target) => {
  // compass bearing (0 = north = -Z, clockwise) from p to target
  const b = Math.atan2(target.x - p.x, -(target.z - p.z)) * (180 / Math.PI);
  return (b + 360) % 360;
};
const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const gatePoint = (ctx) => ctx.lakeEnd.gate.clone();
const touchdownPoint = (ctx) => new THREE.Vector3(ctx.lakeEnd.touchdown.x, ctx.lakeEnd.airport.elev, ctx.lakeEnd.touchdown.y);

export const TUTORIAL = [
  {
    title: 'Welcome to the Raptor',
    info: true,
    text: `You're lined up on the runway at Raptor AFB. Around the screen:
      <ul>
        <li><b>Centre (green HUD):</b> speed in knots on the left, altitude in feet on the right, heading at the top, and the horizon lines. The small circle is the <b>flight-path marker</b>: where the jet is actually going.</li>
        <li><b>Bottom left:</b> throttle, gear, flaps and brakes.</li>
        <li><b>Bottom right:</b> the map. You're the yellow arrow.</li>
        <li><b>Bottom centre:</b> the controls. ${k('H')} hides them, ${k('Esc')} pauses.</li>
      </ul>`,
  },
  {
    title: 'Release the parking brake',
    text: `The jet is held by its parking brake. Press ${k('P')} to release it.`,
    done: ({ physics }) => !physics.controls.parkingBrake,
    success: 'Brake released',
  },
  {
    title: 'Throttle up',
    text: `Hold ${k('W')} to push the throttle to 100%. ${k('S')} pulls it back. Watch the THROTTLE bar, bottom left.`,
    done: ({ physics }) => physics.controls.throttle > 0.98,
    success: 'Full military power',
  },
  {
    title: 'Light the afterburner',
    text: `Press ${k('X')} for afterburner: much more thrust for takeoff. Keep the jet on the centreline with ${k('A')} / ${k('D')} (nose-wheel steering).`,
    done: ({ physics }) => physics.controls.afterburner,
    success: 'Burners lit',
  },
  {
    title: 'Take off',
    text: `Keep it straight with ${k('A')} / ${k('D')}. When the speed reaches <b>140 knots</b>, hold ${k('↓')} gently to raise the nose. (On this jet ${k('↓')} pulls the nose up, like pulling back on a stick.) It will lift off at about 155 knots.`,
    done: ({ physics }) => !physics.s.onGround && physics.s.agl > 15,
    success: 'Airborne!',
  },
  {
    title: 'Gear up',
    text: `Positive climb. Press ${k('G')} to raise the landing gear before you go too fast.`,
    done: ({ physics }) => !physics.config.gearDown,
    success: 'Gear up',
  },
  {
    title: 'Flaps up',
    text: `Press ${k('Shift')}+${k('F')} to raise the flaps until the status shows <b>FLAPS UP</b>. (${k('F')} alone lowers them.) Flaps help at low speed and cost speed later.`,
    done: ({ physics }) => physics.config.flaps === 'up',
    success: 'Clean configuration',
  },
  {
    title: 'How the stick works',
    info: true,
    text: `This is a fly-by-wire jet:
      <ul>
        <li>${k('↓')} / ${k('↑')} ask for more or less <b>G</b>. Let go and the jet holds its current path.</li>
        <li>${k('←')} / ${k('→')} <b>roll</b>. Let go and it holds that bank angle.</li>
        <li>To turn: roll to about 45°, release, then pull ${k('↓')} a little. To straighten out, roll back level.</li>
      </ul>`,
  },
  {
    title: 'Climb to 3,000 feet',
    text: `Pull ${k('↓')} until the flight-path marker is about 10° above the horizon, then let go. Watch the altitude box on the right reach <b>3,000 ft</b>.`,
    done: ({ physics }) => physics.altitude * FT > 3000,
    success: '3,000 feet',
  },
  {
    title: 'Level off and cut the burner',
    text: `Press ${k('X')} to turn the afterburner off and hold ${k('S')} to bring the throttle to about <b>70%</b>. Push ${k('↑')} gently until the flight-path marker sits on the horizon (VS near 0).`,
    done: ({ physics }) => !physics.controls.afterburner && physics.controls.throttle < 0.85 && Math.abs(physics.s.vs * FT * 60) < 800,
    success: 'Level cruise',
  },
  {
    title: 'Turn towards Lakeside Field',
    text: `The green ring (and green dot on the map) marks the approach to <b>Lakeside Field</b>. Roll with ${k('→')} or ${k('←')} to about 45°, let go, pull ${k('↓')} gently, and roll out level when the ring is straight ahead.`,
    target: gatePoint,
    targetLabel: 'Approach gate',
    done: ({ physics, lakeEnd }) => angleDiff(physics.headingDeg, bearingTo(physics.pos, lakeEnd.gate)) < 20 && Math.abs(physics.s.bank) < 0.35,
    success: 'On course',
  },
  {
    title: 'Fly to the approach gate',
    text: 'Fly through the green ring. Adjust the throttle to hold about 300 knots, and keep the ring centred.',
    target: gatePoint,
    targetLabel: 'Approach gate',
    done: ({ physics, lakeEnd }) => physics.pos.distanceTo(lakeEnd.gate) < 2500,
    success: 'At the gate. The runway is ahead',
  },
  {
    title: 'Configure for landing',
    text: `Gear down with ${k('G')}, press ${k('F')} twice for <b>LANDING</b> flaps, and slow below <b>170 knots</b> with ${k('S')} (or ${k('B')} for the speed brake).`,
    target: touchdownPoint,
    targetLabel: 'Touchdown',
    done: ({ physics }) => physics.config.gearDown && physics.config.flaps === 'landing' && physics.speed * KT < 175,
    success: 'Configured',
  },
  {
    title: 'Read the PAPI lights',
    info: true,
    text: `Four lights left of the runway show your glide path:
      <ul>
        <li><b>2 white, 2 red</b>: on the glide path.</li>
        <li><b>More white</b>: too high. Ease ${k('↑')} or reduce throttle.</li>
        <li><b>More red</b>: too low. Ease ${k('↓')} or add throttle.</li>
      </ul>
      Put the flight-path marker on the runway numbers and hold about <b>150 knots</b>.`,
  },
  {
    title: 'Land',
    text: `Follow the PAPI down. Just above the runway, pull ${k('↓')} gently to <b>flare</b> and soften the touchdown. Keep the wings level, and touch down with the gear down.`,
    target: touchdownPoint,
    targetLabel: 'Touchdown',
    done: ({ physics }) => physics.s.onGround && physics.s.runway != null,
    success: 'Touchdown!',
  },
  {
    title: 'Stop',
    text: `Throttle to idle with ${k('S')}, then hold ${k('Space')} to brake until you stop. ${k('B')} (speed brake) helps too.`,
    done: ({ physics }) => physics.s.onGround && physics.speed < 2,
    success: 'Stopped. Welcome to Lakeside',
  },
];
