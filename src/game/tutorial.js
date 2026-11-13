import * as THREE from 'three';

/*
 * Interactive tutorials, generated for the selected aircraft. Each step shows instructions and completes
 * when its `done` check passes (or, for `info` steps, when the player presses Enter).
 * ctx = { physics, ac (airframe data), dest: { name, target: Vector3, touchdown: Vector3, gate: Vector3 } }.
 */

const KT = 1.94384;
const FT = 3.28084;
const k = (key) => `<kbd>${key}</kbd>`;

const bearingTo = (p, t) => (Math.atan2(t.x - p.x, -(t.z - p.z)) * (180 / Math.PI) + 360) % 360;
const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

const HUD_TOUR = {
  title: 'Welcome aboard',
  info: true,
  text: `Around the screen:
    <ul>
      <li><b>Centre (green HUD):</b> speed in knots on the left, altitude in feet on the right, heading at the top. The small circle is the <b>flight-path marker</b>: where you're actually going.</li>
      <li><b>Bottom left:</b> throttle, gear, flaps and brakes. <b>Bottom right:</b> the map (you're the yellow arrow; the green dot is your target).</li>
      <li><b>Bottom centre:</b> the controls. ${k('H')} hides them, ${k('Esc')} pauses and lists every key.</li>
    </ul>`,
};

const STICK = {
  title: 'How the stick works',
  info: true,
  text: `Fly-by-wire:
    <ul>
      <li>${k('↓')} / ${k('↑')} pull / push for more or less <b>G</b>. Let go and it holds its path.</li>
      <li>${k('←')} / ${k('→')} <b>roll</b>. Let go and it holds the bank.</li>
      <li>To turn: roll about 30°, release, pull ${k('↓')} a little. Roll back level to stop turning.</li>
    </ul>`,
};

function runwayTutorial(ac, ctx) {
  const dest = ctx.dest;
  const steps = [
    HUD_TOUR,
    {
      title: 'Release the parking brake',
      text: `You're lined up on the runway at <b>${ctx.depName}</b>. Press ${k('P')} to release the parking brake.`,
      done: ({ physics }) => !physics.controls.parkingBrake,
      success: 'Brake released',
    },
    {
      title: 'Takeoff power',
      text: `Hold ${k('W')} to push the throttle to 100%. ${k('S')} pulls it back. Keep straight with ${k('A')} / ${k('D')} (nose-wheel steering).`,
      done: ({ physics }) => physics.controls.throttle > 0.98,
      success: 'Takeoff power set',
    },
  ];
  if (ac.afterburner) {
    steps.push({
      title: 'Afterburner',
      text: `Press ${k('X')} to light the afterburners (reheat). They give much more thrust for takeoff.`,
      done: ({ physics }) => physics.controls.afterburner,
      success: 'Reheat lit',
    });
  }
  steps.push(
    {
      title: 'Rotate and take off',
      text: `At <b>${ac.vRotateKt} knots</b> hold ${k('↓')} gently to raise the nose. (${k('↓')} pulls the nose up, like a stick.) Let it fly off the runway.`,
      done: ({ physics }) => !physics.s.onGround && physics.s.agl > 15,
      success: 'Airborne!',
    },
    {
      title: 'Gear up',
      text: `Positive climb. Press ${k('G')} to raise the landing gear.`,
      done: ({ physics }) => !physics.config.gearDown,
      success: 'Gear up',
    },
    {
      title: 'Flaps up',
      text: `Press ${k('Shift')}+${k('F')} until the status shows <b>FLAPS UP</b>. (${k('F')} alone lowers them.)`,
      done: ({ physics }) => physics.config.flaps === 'up',
      success: 'Clean',
    },
    STICK,
    {
      title: `Climb to ${ac.climbFt.toLocaleString()} feet`,
      text: `Pull ${k('↓')} until the flight-path marker is about 10° above the horizon, then let go. Watch the altitude box reach <b>${ac.climbFt.toLocaleString()} ft</b>.`,
      done: ({ physics }) => physics.altitude * FT > ac.climbFt,
      success: `${ac.climbFt.toLocaleString()} feet`,
    },
    {
      title: 'Level off',
      text: `${ac.afterburner ? `Press ${k('X')} to cancel reheat, ` : ''}hold ${k('S')} to bring the throttle to about <b>${Math.round(ac.cruiseThrottle * 100)}%</b>, and push ${k('↑')} gently until the flight-path marker sits on the horizon.`,
      done: ({ physics }) => !physics.controls.afterburner && physics.controls.throttle < ac.cruiseThrottle + 0.12 && Math.abs(physics.s.vs * FT * 60) < 800,
      success: 'Level cruise',
    },
    {
      title: `Turn towards ${dest.name}`,
      text: `The green ring (and the green dot on the map) marks the approach to <b>${dest.name}</b>. Roll with ${k('←')} / ${k('→')}, pull ${k('↓')} gently, and roll out when the ring is straight ahead.`,
      target: () => dest.gate,
      targetLabel: 'Approach gate',
      done: ({ physics }) => angleDiff(physics.headingDeg, bearingTo(physics.pos, dest.gate)) < 20 && Math.abs(physics.s.bank) < 0.35,
      success: 'On course',
    },
    {
      title: 'Fly to the approach gate',
      text: 'Fly through the green ring. Use the throttle to keep a sensible speed, and keep the ring centred.',
      target: () => dest.gate,
      targetLabel: 'Approach gate',
      done: ({ physics }) => physics.pos.distanceTo(dest.gate) < 2500,
      success: 'At the gate. The runway is ahead',
    },
    {
      title: 'Configure for landing',
      text: `Gear down with ${k('G')}, press ${k('F')} until <b>FLAPS LANDING</b>, and slow below <b>${ac.vApproachKt + 20} knots</b> with ${k('S')} (and ${k('B')} for the speed brake).`,
      target: () => dest.touchdown,
      targetLabel: 'Touchdown',
      done: ({ physics }) => physics.config.gearDown && physics.config.flaps === 'landing' && physics.speed * KT < ac.vApproachKt + 25,
      success: 'Configured',
    },
    {
      title: 'Read the PAPI lights',
      info: true,
      text: `Four lights beside the runway show your glide path: <b>2 white + 2 red</b> means on the path; more white is too high, more red is too low. The green outline on the HUD marks the runway. Put the flight-path marker on the runway numbers and hold about <b>${ac.vApproachKt} knots</b>.`,
    },
    {
      title: 'Land',
      text: `Follow the PAPI down. Just above the runway, pull ${k('↓')} gently to <b>flare</b>. Keep the wings level and touch down on the runway.`,
      target: () => dest.touchdown,
      targetLabel: 'Touchdown',
      done: ({ physics }) => physics.s.onGround && physics.s.runway != null,
      success: 'Touchdown!',
    },
    {
      title: 'Stop',
      text: `Throttle to idle with ${k('S')}, then hold ${k('Space')} to brake until you stop.`,
      done: ({ physics }) => physics.s.onGround && physics.speed < 2,
      success: `Stopped. Welcome to ${dest.name}`,
    },
  );
  return steps;
}

function seagliderTutorial(ac, ctx) {
  const dest = ctx.dest;
  return [
    HUD_TOUR,
    {
      title: 'A seaglider',
      info: true,
      text: `This electric seaglider operates only over water. It floats on its <b>hull</b>, rises onto a <b>hydrofoil</b> as it speeds up, then flies a few metres above the waves in <b>ground effect</b>, where the wing is most efficient. It stays below about <b>${ac.maxAglFt} ft</b>, and it can't land on runways or ground: only water.`,
    },
    {
      title: 'Power up',
      text: `Hold ${k('W')} to bring the eight electric motors up to 100%. Steer on the water with ${k('A')} / ${k('D')}.`,
      done: ({ physics }) => physics.controls.throttle > 0.98,
      success: 'Full power',
    },
    {
      title: 'Up on the foil',
      text: `Keep the hydrofoil down (status <b>FOIL DN</b>). Past about 35 knots the hull lifts clear of the water and drag drops: you're <b>foilborne</b>.`,
      done: ({ physics }) => physics.s.foilborne || !physics.s.onGround,
      success: 'Foilborne',
    },
    {
      title: 'Take off',
      text: `At <b>${ac.vRotateKt} knots</b> pull ${k('↓')} gently to lift off the water.`,
      done: ({ physics }) => !physics.s.onGround && physics.s.agl > 3,
      success: 'Flying in ground effect',
    },
    {
      title: 'Retract the foil',
      text: `Press ${k('G')} to retract the hydrofoil, and ${k('Shift')}+${k('F')} to raise the flaps.`,
      done: ({ physics }) => !physics.config.gearDown && physics.config.flaps === 'up',
      success: 'Clean',
    },
    STICK,
    {
      title: 'Cruise in ground effect',
      text: `Hold <b>20 to 40 ft</b> above the water (altitude box) with small ${k('↓')} / ${k('↑')} inputs, and set about <b>${Math.round(ac.cruiseThrottle * 100)}%</b> throttle with ${k('S')}.`,
      done: ({ physics }) => physics.s.agl * FT > 15 && physics.s.agl * FT < 45 && physics.controls.throttle < ac.cruiseThrottle + 0.15,
      success: 'Cruising',
    },
    {
      title: `Head for ${dest.name}`,
      text: `Turn gently (small banks only, you're close to the water) towards the green ring, then fly to it.`,
      target: () => dest.gate,
      targetLabel: dest.name,
      done: ({ physics }) => physics.pos.distanceTo(dest.gate) < 1500,
      success: 'Arrived',
    },
    {
      title: 'Land on the water',
      text: `Throttle back with ${k('S')}, lower the foil (${k('G')}) and flaps (${k('F')}), and let it settle gently onto the water, wings level.`,
      target: () => dest.gate,
      targetLabel: dest.name,
      done: ({ physics }) => physics.s.onGround && physics.s.onWater,
      success: 'Splashdown',
    },
    {
      title: 'Come off the foil',
      text: `Throttle to idle and hold ${k('Space')} (reverse pitch) to slow down to a stop.`,
      done: ({ physics }) => physics.s.onGround && physics.speed < 2,
      success: `Welcome to ${dest.name}`,
    },
  ];
}

export function buildTutorial(ac, ctx) {
  return ac.amphibious ? seagliderTutorial(ac, ctx) : runwayTutorial(ac, ctx);
}

export { THREE };
