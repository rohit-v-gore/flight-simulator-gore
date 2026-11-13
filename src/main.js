import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import GUI from 'lil-gui';
import { F22 } from './f22/F22.js';
import { WING, STAB, NOZZLE } from './f22/dims.js';
import { bodyParams, S_END } from './f22/body.js';
import { MAIN_BAY } from './f22/bays.js';
import { buildAirbase, buildFlightWorld } from './world/world.js';

/*
 * F-22 viewer: the procedural jet at an air base or in flight, with a control panel, keyboard
 * controls, a planform HUD and preset camera views. `?test` keeps the drawing buffer for screenshots.
 */

const query = new URLSearchParams(location.search);
const TEST_MODE = query.has('test');

/* ------------------------------- renderer ------------------------------- */

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: TEST_MODE });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.25, 50000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.minDistance = 2.5;
controls.maxDistance = 400;
controls.maxPolarAngle = Math.PI * 0.49;

const view = {
  livery: 'raptor',
  tanks: false,
  crew: true,
  environment: 'apron',
  sunElevation: 34,
  sunAzimuth: 50,
  clouds: 0.35,
  exposure: 1,
  shadows: true,
  autoRotate: false,
  vectorDemo: false,
  controlsDemo: false,
  baysDemo: false,
};

/* ------------------------------ sky and light ------------------------------ */

const sky = new Sky();
sky.scale.setScalar(45000);
const skyU = sky.material.uniforms;
skyU.turbidity.value = 3;
skyU.rayleigh.value = 1.2;
skyU.mieCoefficient.value = 0.004;
skyU.mieDirectionalG.value = 0.8;
scene.add(sky);

// a sun-disc-free copy of the sky renders the image-based lighting
const envSky = new Sky();
envSky.scale.setScalar(1000);
envSky.material.uniforms.showSunDisc.value = 0;
const envScene = new THREE.Scene();
envScene.add(envSky);
const envFloor = new THREE.Mesh(new THREE.CircleGeometry(800, 32), new THREE.MeshBasicMaterial({ color: 0x4f4c46 }));
envFloor.rotation.x = -Math.PI / 2;
envFloor.position.y = -2;
envScene.add(envFloor);
const pmrem = new THREE.PMREMGenerator(renderer);
let envTarget = null;

const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 1, far: 160 });
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);
const skyFill = new THREE.HemisphereLight(0xbfd6ff, 0x5a5448, 0.4);
scene.add(skyFill);

const sunDir = new THREE.Vector3();
const warm = new THREE.Color(0xff9a52);
const white = new THREE.Color(0xfff6ea);

/** Place the sun, tint and scale it with elevation, and rebuild the environment lighting. */
function updateSun() {
  const elev = THREE.MathUtils.degToRad(view.sunElevation);
  sunDir.setFromSphericalCoords(1, Math.PI / 2 - elev, THREE.MathUtils.degToRad(view.sunAzimuth));
  for (const s of [sky, envSky]) {
    s.material.uniforms.sunPosition.value.copy(sunDir);
    s.material.uniforms.cloudCoverage.value = view.clouds;
  }
  const high = THREE.MathUtils.smoothstep(view.sunElevation, -2, 25);
  sun.color.copy(warm).lerp(white, high);
  sun.intensity = 3.4 * THREE.MathUtils.smoothstep(view.sunElevation, -3, 12);
  skyFill.intensity = 0.15 + 0.45 * high;
  envFloor.material.color.set(view.environment === 'flight' ? 0x253a3c : 0x5e5a52).multiplyScalar(0.25 + 0.75 * high);
  renderer.toneMappingExposure = view.exposure * (0.55 + 0.45 * (1 - high));
  if (envTarget) envTarget.dispose();
  envTarget = pmrem.fromScene(envScene, 0.03);
  scene.environment = envTarget.texture;
  scene.environmentIntensity = 0.6;
}

/* ---------------------------------- jet ---------------------------------- */

const buildStart = performance.now();
const jet = new F22(renderer, { livery: view.livery });
scene.add(jet.root);
const buildMs = performance.now() - buildStart;

const airbase = buildAirbase(renderer, jet);
scene.add(airbase.group);
const flightWorld = buildFlightWorld(renderer);
flightWorld.group.visible = false;
scene.add(flightWorld.group);
scene.fog = new THREE.Fog(0xb8c8d6, 2500, 14000);
document.getElementById('loading')?.remove();
updateSun();

/* ------------------------------- camera views ------------------------------- */

const VIEWS = {
  'Three-quarter': [[13, 4.2, 14.5], [0, 1.5, 0]],
  Front: [[26, 2, 0.01], [0, 1.7, 0]],
  Side: [[0.01, 2, 27], [0, 1.7, 0]],
  Top: [[0.01, 36, 0.02], [0, 1.5, 0]],
  Rear: [[-16, 5.2, 10], [0, 1.6, 0]],
  Cockpit: [[8.2, 4.6, 4.2], [3.6, 2.9, 0]],
  'Nozzles close-up': [[-14.5, 3.4, 5.5], [-8.2, 2.2, 0]],
  'Weapons bays': [[3.2, 0.25, 5.2], [-0.9, 1.25, 0]],
};
let glide = null;
function setView(name, instant = false) {
  const v = VIEWS[name];
  if (!v) return;
  const pos = new THREE.Vector3(...v[0]).add(jet.root.position);
  const target = new THREE.Vector3(...v[1]).add(jet.root.position);
  if (instant) {
    camera.position.copy(pos);
    controls.target.copy(target);
    controls.update();
    glide = null;
  } else {
    glide = { t: 0, pos0: camera.position.clone(), target0: controls.target.clone(), pos, target };
  }
}

const S = jet.state;
const P = jet.pos;

/* ------------------------------ ground roll ------------------------------ */

/*
 * At the air base the jet can taxi and take off: thrust minus rolling friction, drag and brakes sets its
 * speed, the rudder pedals steer the nosewheel, and pulling back above rotation speed lifts it into the
 * flight scene. It starts parked with the parking brake set.
 */
const ROLL = {
  rotateSpeed: 72, // m/s (~140 kt)
  wheelbase: 7.5, // nose to main gear, m
  dryAccel: 6.5, // m/s² at military power
  burnerAccel: 4.5, // extra m/s² in full afterburner
  rolling: 0.25, // rolling friction, m/s²
  dragK: 0.00035, // aerodynamic drag, (m/s²) per (m/s)²
  brakeDecel: 6, // wheel brakes, m/s²
};
const roll = { speed: 0, heading: 0, x: 0, z: 0, parkingBrake: true };

function parkAtStand() {
  Object.assign(roll, { speed: 0, heading: 0, x: 0, z: 0, parkingBrake: true });
  jet.root.position.set(0, 0, 0);
}

function groundRoll(dt) {
  const thrust = ROLL.dryAccel * THREE.MathUtils.clamp((P.throttle - 0.18) / 0.82, 0, 1) + ROLL.burnerAccel * P.ab;
  const braking = roll.parkingBrake || held.has(' ') ? ROLL.brakeDecel : 0;
  const resist = (roll.speed > 0.01 ? ROLL.rolling : 0) + ROLL.dragK * roll.speed * roll.speed + braking;
  roll.speed = Math.max(0, roll.speed + (thrust - resist) * dt);
  if (roll.parkingBrake && thrust < ROLL.brakeDecel) roll.speed = 0;
  // nosewheel steering: full 40° at taxi speed, washing out as speed builds
  const steer = THREE.MathUtils.degToRad(40) * S.yaw * THREE.MathUtils.clamp(1 - roll.speed / 40, 0.08, 1);
  roll.heading -= (roll.speed * Math.tan(steer) / ROLL.wheelbase) * dt; // left pedal (yaw < 0) turns left
  const before = jet.root.position.clone();
  roll.x += Math.cos(roll.heading) * roll.speed * dt;
  roll.z -= Math.sin(roll.heading) * roll.speed * dt;
  jet.root.position.set(roll.x, 0, roll.z);
  jet.root.rotation.set(0, roll.heading, 0);
  // keep the camera with the jet
  const moved = jet.root.position.clone().sub(before);
  camera.position.add(moved);
  controls.target.add(moved);
  S.mach = Math.max(0, roll.speed / 340);
  // rotation and lift-off
  if (roll.speed > ROLL.rotateSpeed && S.pitch > 0.25) {
    const speed = roll.speed;
    setEnvironment('flight');
    S.mach = Math.max(0.3, speed / 340);
  }
}

/* ---------------------------------- panel ---------------------------------- */

const gui = new GUI({ title: 'F-22 Raptor' });
{
  const f = gui.addFolder('Flight');
  f.add(S, 'mach', 0.1, 2.25, 0.01).name('Mach').listen();
  f.add(S, 'flaps', { Up: 'up', 'Takeoff (LEF 15° / flaperons 20°)': 'takeoff', 'Landing (LEF 22° / flaperons 30°)': 'landing' }).name('High lift').listen();
  f.add(S, 'speedBrake').name('Speed brake (surface mix)').listen();
}
{
  const f = gui.addFolder('Flight controls');
  f.add(S, 'pitch', -1, 1, 0.01).name('Pitch (stabilators)').listen();
  f.add(S, 'roll', -1, 1, 0.01).name('Roll (ailerons, flaperons)').listen();
  f.add(S, 'yaw', -1, 1, 0.01).name('Yaw (rudders)').listen();
  f.add(S, 'thrustVectoring').name('Thrust vectoring').listen();
  f.add(view, 'controlsDemo').name('Exercise controls').listen();
  f.add(view, 'vectorDemo').name('Post-stall pitch demo').listen();
  f.add({ centre: () => Object.assign(S, { pitch: 0, roll: 0, yaw: 0 }) }, 'centre').name('Centre controls');
}
{
  const f = gui.addFolder('Weapons bays');
  f.add(S, 'mainBay').name('Main bay (6× AIM-120)').listen();
  f.add(S, 'sideBays').name('Side bays (2× AIM-9)').listen();
  f.add(view, 'baysDemo').name('Bay cycle demo').listen();
}
{
  const f = gui.addFolder('Systems');
  f.add(S, 'gearDown').name('Landing gear down').listen();
  f.add(S, 'canopyOpen').name('Canopy open').listen();
  f.add(S, 'hookDown').name('Arresting hook down').listen();
  f.add(S, 'throttle', 0, 1, 0.01).name('Throttle (MIL = 1)').listen();
  f.add(S, 'afterburner', 0, 1, 0.01).name('Afterburner').listen();
  f.add(S, 'lights').name('Lights').listen();
  f.add(roll, 'parkingBrake').name('Parking brake').listen();
  f.add({ park: () => setEnvironment('apron') }, 'park').name('Back to parking spot');
}
{
  const f = gui.addFolder('Appearance');
  f.add(view, 'livery', { 'Have Glass two-tone grey': 'raptor', 'Ghost grey (test fleet)': 'ghost' }).name('Paint scheme').onChange((k) => jet.setLivery(k));
  f.add(view, 'tanks').name('Ferry tanks').onChange((v) => jet.setTanks(v));
  f.add(view, 'crew').name('Pilot').onChange((v) => (jet.cockpit.crew.visible = v));
  f.add(view, 'environment', { 'Air base (parked)': 'apron', 'In flight': 'flight' }).name('Scene').onChange(setEnvironment);
  f.add(view, 'sunElevation', -2, 85, 0.5).name('Sun elevation').onChange(updateSun);
  f.add(view, 'sunAzimuth', 0, 360, 1).name('Sun azimuth').onChange(updateSun);
  f.add(view, 'clouds', 0, 1, 0.01).name('Cloud cover').onChange(updateSun);
  f.add(view, 'exposure', 0.25, 4, 0.01).name('Exposure').onChange(updateSun);
  f.add(view, 'shadows').name('Shadows').onChange((v) => (sun.castShadow = v));
  f.close();
}
{
  const f = gui.addFolder('Camera');
  for (const name of Object.keys(VIEWS)) f.add({ go: () => setView(name) }, 'go').name(name);
  f.add(view, 'autoRotate').name('Auto-rotate').onChange((v) => (controls.autoRotate = v));
  f.close();
}
if (innerWidth < 900 || TEST_MODE) gui.close();

function setEnvironment(env) {
  view.environment = env;
  const flying = env === 'flight';
  airbase.group.visible = !flying;
  flightWorld.group.visible = flying;
  jet.weightOnWheels = !flying;
  scene.fog.near = flying ? 6000 : 2500;
  scene.fog.far = flying ? 42000 : 14000;
  controls.maxPolarAngle = flying ? Math.PI : Math.PI * 0.49;
  // the jet sits at the origin in both scenes; bring the camera along
  const offset = jet.root.position.clone();
  camera.position.sub(offset);
  controls.target.sub(offset);
  parkAtStand();
  if (!flying) jet.root.rotation.set(0, 0, 0);
  if (flying) {
    Object.assign(S, { gearDown: false, hookDown: false, canopyOpen: false, flaps: 'up' });
    S.mach = Math.max(S.mach, 0.8);
  } else {
    Object.assign(S, { gearDown: true, afterburner: 0, throttle: 0.3 });
    S.mach = 0;
  }
  updateSun();
}

/* ----------------------------------- HUD ----------------------------------- */

const planCanvas = document.getElementById('planform');
const planCtx = planCanvas.getContext('2d');
const readout = document.getElementById('readout');

/** Planform of the fuselage edge, sampled once: [s, half-width]. */
const fuselageEdge = Array.from({ length: Math.ceil(S_END / 0.1) + 1 }, (_, i) => {
  const s = Math.min(i * 0.1, S_END);
  return [s, bodyParams(s).a];
});

/** Colour for a surface deflection: orange trailing-edge down / green up, stronger with angle. */
const deflectionFill = (deg) => {
  const k = 0.15 + 0.7 * Math.min(1, Math.abs(deg) / 25);
  return deg >= 0 ? `rgba(255,170,90,${k})` : `rgba(120,255,170,${k})`;
};

/** Top-down sketch of the jet with live control-surface deflections, bay state and nozzle vector. */
function drawPlanform() {
  const g = planCtx;
  const { width, height } = planCanvas;
  const scale = height / 21.5;
  const toPx = ([s, y]) => [width / 2 + y * scale, 14 + s * scale];
  const shape = (pts, fill, stroke = null, lineWidth = 1) => {
    g.beginPath();
    pts.map(toPx).forEach(([x, z], i) => (i ? g.lineTo(x, z) : g.moveTo(x, z)));
    g.closePath();
    if (fill) {
      g.fillStyle = fill;
      g.fill();
    }
    if (stroke) {
      g.strokeStyle = stroke;
      g.lineWidth = lineWidth;
      g.stroke();
    }
  };
  const band = (range, fore, aft, side) => [[fore(range.y0), side * range.y0], [fore(range.y1), side * range.y1], [aft(range.y1), side * range.y1], [aft(range.y0), side * range.y0]];
  const le = (y) => WING.leS(y);
  const te = (y) => WING.teS(y);
  g.clearRect(0, 0, width, height);
  for (const side of [1, -1]) {
    const sfx = side > 0 ? 'R' : 'L';
    shape([[le(1.6), side * 1.6], [le(WING.yTip), side * WING.yTip], [te(WING.yTip), side * WING.yTip], [te(1.6), side * 1.6]], 'rgba(120,200,255,0.3)', '#9fd8ff', 1.5);
    shape(band(WING.lef, le, (y) => le(y) + WING.lef.chord, side), deflectionFill(P.lef));
    shape(band(WING.flaperon, (y) => te(y) - WING.flaperon.chord, te, side), deflectionFill(P[`flaperon${sfx}`]));
    shape(band(WING.aileron, (y) => te(y) - WING.aileron.chord, te, side), deflectionFill(P[`aileron${sfx}`]));
    const stab = P[`stab${sfx}`];
    shape(
      [[STAB.root.le, side * STAB.root.y], [STAB.tip.le, side * STAB.tip.y], [STAB.tip.te, side * STAB.tip.y], [STAB.root.te, side * STAB.root.y]],
      `rgba(255,255,255,${0.18 + 0.5 * Math.min(1, Math.abs(stab) / 25)})`,
    );
  }
  shape([...fuselageEdge, ...fuselageEdge.slice().reverse().map(([s, y]) => [s, -y])], 'rgba(230,236,242,0.85)', 'rgba(255,255,255,0.9)');
  if (P.mainBay > 0.01) {
    shape([[MAIN_BAY.s0, -MAIN_BAY.hw], [MAIN_BAY.s1, -MAIN_BAY.hw], [MAIN_BAY.s1, MAIN_BAY.hw], [MAIN_BAY.s0, MAIN_BAY.hw]], `rgba(255,120,80,${0.6 * P.mainBay})`);
  }
  g.fillStyle = '#ff9b54';
  for (const side of [1, -1]) {
    const [x, z] = toPx([NOZZLE.sExit, side * NOZZLE.y]);
    g.fillRect(x - 3, z - 3, 6, 6);
  }
  g.fillStyle = '#fff';
  g.font = '600 24px system-ui, sans-serif';
  g.textAlign = 'left';
  g.fillText(`TV ${P.vector >= 0 ? '+' : ''}${P.vector.toFixed(0)}°`, 10, height - 14);
}

const travel = (v, words) => (v > 0.99 ? words[1] : v < 0.01 ? words[0] : words[2]);

function updateReadout() {
  const rows = [
    ['Mach', S.mach.toFixed(2), 'High lift', S.flaps.toUpperCase()],
    ['LEF', `${P.lef.toFixed(0)}°`, 'Flaperons', `${P.flaperonR.toFixed(0)}°/${P.flaperonL.toFixed(0)}°`],
    ['Thrust vector', `${P.vector.toFixed(1)}°`, '', `<span class="dim">${S.thrustVectoring ? 'pitch axis' : 'OFF'}</span>`],
    ['Main bay', travel(P.mainBay, ['CLOSED', 'OPEN', 'MOVING']), 'Side', travel(P.sideBay, ['CLOSED', 'OPEN', 'MOVING'])],
    ['Gear', travel(P.gear, ['UP', 'DOWN', 'TRANSIT']), 'Hook', S.hookDown ? 'DN' : 'UP'],
    ['Engines', `${(P.throttle * 100).toFixed(0)}%${P.ab > 0.01 ? ` + AB ${(P.ab * 100).toFixed(0)}%` : ''}`, 'SB', P.speedBrake > 0.5 ? 'OUT' : 'IN'],
  ];
  const html = rows.map(([k1, v1, k2, v2]) => `<b>${k1}</b> ${v1}${k2 ? ` <b>${k2}</b>` : ''} ${v2}`);
  if (view.environment !== 'flight') {
    html.push(`<b>Ground speed</b> ${(roll.speed * 1.944).toFixed(0)} kt ${roll.parkingBrake ? '<span class="warn">PARKING BRAKE (P)</span>' : held.has(' ') ? '<span class="warn">BRAKES</span>' : ''}`);
  }
  for (const note of jet.info.notes) html.push(`<span class="warn">${note}</span>`);
  readout.innerHTML = html.join('<br>');
}

/* --------------------------------- keyboard --------------------------------- */

const held = new Set();
const HIGH_LIFT = ['up', 'takeoff', 'landing'];
const TOGGLES = {
  p: () => (roll.parkingBrake = !roll.parkingBrake),
  '=': () => (S.throttle = Math.min(1, S.throttle + 0.1)),
  '+': () => (S.throttle = Math.min(1, S.throttle + 0.1)),
  '-': () => {
    S.throttle = Math.max(0, S.throttle - 0.1);
    if (S.throttle < 1) S.afterburner = 0;
  },
  g: () => (S.gearDown = !S.gearDown),
  c: () => (S.canopyOpen = !S.canopyOpen),
  h: () => (S.hookDown = !S.hookDown),
  b: () => (S.speedBrake = !S.speedBrake),
  w: () => (S.mainBay = !S.mainBay),
  s: () => (S.sideBays = !S.sideBays),
  v: () => (S.thrustVectoring = !S.thrustVectoring),
  l: () => (S.lights = !S.lights),
  f: () => (S.flaps = HIGH_LIFT[(HIGH_LIFT.indexOf(S.flaps) + 1) % HIGH_LIFT.length]),
  a: () => {
    S.afterburner = S.afterburner > 0 ? 0 : 1;
    if (S.afterburner) S.throttle = 1;
  },
  r: () => (view.autoRotate = controls.autoRotate = !controls.autoRotate),
};
addEventListener('keydown', (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(e.target?.tagName || '')) return;
  const k = e.key.toLowerCase();
  if (k === ' ' || k.startsWith('arrow')) e.preventDefault();
  held.add(k);
  if (e.repeat) return;
  if (TOGGLES[k]) TOGGLES[k]();
  const n = Number(k);
  const names = Object.keys(VIEWS);
  if (n >= 1 && n <= names.length) setView(names[n - 1]);
});
addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));
addEventListener('blur', () => held.clear());

// stick axes: keys push towards ±1, releasing springs the axis back to centre
const AXES = [['pitch', 'arrowup', 'arrowdown'], ['roll', 'arrowleft', 'arrowright'], ['yaw', 'q', 'e']];
const springing = new Set();
function stickFromKeys(dt) {
  for (const [axis, minus, plus] of AXES) {
    const want = (held.has(plus) ? 1 : 0) - (held.has(minus) ? 1 : 0);
    if (want !== 0) springing.add(axis);
    if (!springing.has(axis)) continue; // leave panel-set values alone
    S[axis] = THREE.MathUtils.clamp(S[axis] + THREE.MathUtils.clamp(want - S[axis], -3 * dt, 3 * dt), -1, 1);
    if (want === 0 && S[axis] === 0) springing.delete(axis);
  }
}

/* -------------------------------- main loop -------------------------------- */

let lastFrame = performance.now();
let time = 0;
let running = true;

function step(dt) {
  time += dt;
  if (view.vectorDemo) Object.assign(S, { thrustVectoring: true, pitch: 0.5 + 0.5 * Math.sin(time * 0.8), afterburner: 1, throttle: 1 });
  if (view.controlsDemo) Object.assign(S, { pitch: 0.7 * Math.sin(time * 1.3), roll: 0.8 * Math.sin(time * 0.9 + 1), yaw: 0.6 * Math.sin(time * 0.7 + 2) });
  if (view.baysDemo) {
    const cycle = (time * 0.25) % 1;
    S.mainBay = cycle < 0.45;
    S.sideBays = cycle > 0.2 && cycle < 0.7;
  }
  stickFromKeys(dt);
  jet.update(dt);
  if (view.environment === 'flight') {
    flightWorld.update(dt, Math.max(60, S.mach * 340));
    jet.root.position.y = 0.25 * Math.sin(time * 0.6);
    jet.root.rotation.set(0.03 * Math.sin(time * 0.45), 0, 0.02 * Math.sin(time * 0.3));
  } else {
    groundRoll(dt);
  }
  if (glide) {
    glide.t = Math.min(1, glide.t + dt / 0.9);
    const e = THREE.MathUtils.smootherstep(glide.t, 0, 1);
    camera.position.lerpVectors(glide.pos0, glide.pos, e);
    controls.target.lerpVectors(glide.target0, glide.target, e);
    if (glide.t >= 1) glide = null;
  }
}

function draw() {
  controls.update();
  sun.target.position.copy(jet.root.position);
  sun.position.copy(jet.root.position).addScaledVector(sunDir, 60);
  skyU.time.value = time;
  renderer.render(scene, camera);
  drawPlanform();
  updateReadout();
}

function frame(now = performance.now()) {
  if (!running) return;
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;
  step(Math.max(dt, 0));
  draw();
  requestAnimationFrame(frame);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

setView('Three-quarter', true);
requestAnimationFrame(frame);

// hooks for automated checks and console tinkering
window.__f22 = {
  jet, scene, camera, controls, renderer, view, sun, sky, THREE, buildMs, setView, setEnvironment, updateSun,
  pause: () => (running = false),
  resume: () => {
    if (running) return;
    running = true;
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  },
  /** Snap every system to its target and draw one frame. */
  renderNow: () => {
    jet.update(0, true);
    draw();
  },
  ready: true,
};
