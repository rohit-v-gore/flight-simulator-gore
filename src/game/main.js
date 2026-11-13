import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { F22 } from '../f22/F22.js';
import { GamePhysics } from './physics.js';
import { buildGameWorld, AIRPORTS } from './gameWorld.js';
import { TUTORIAL } from './tutorial.js';

/*
 * F-22 flight game: menu → mission (tutorial, free flight or landing challenge) → debrief.
 * The physics runs in physics.js; this file wires input, cameras, HUD, missions and rendering.
 */

const D2R = Math.PI / 180;
const KT = 1.94384; // m/s -> knots
const FT = 3.28084; // m -> feet
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/* ------------------------------- renderer & scene ------------------------------- */

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: new URLSearchParams(location.search).has('test') });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.6;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
$('view').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xbccbd8, 12000, 45000);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 1, 60000);

const sky = new Sky();
sky.scale.setScalar(50000);
Object.assign(sky.material.uniforms.turbidity, { value: 3 });
sky.material.uniforms.rayleigh.value = 1.2;
sky.material.uniforms.mieCoefficient.value = 0.004;
sky.material.uniforms.cloudCoverage.value = 0.25;
scene.add(sky);
const sunDir = new THREE.Vector3().setFromSphericalCoords(1, (90 - 38) * D2R, 140 * D2R);
sky.material.uniforms.sunPosition.value.copy(sunDir);
const sun = new THREE.DirectionalLight(0xfff4e6, 3.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 300 });
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target, new THREE.HemisphereLight(0xc4dcff, 0x5d5446, 0.55));
{
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(1000);
  envSky.material.uniforms.sunPosition.value.copy(sunDir);
  envSky.material.uniforms.showSunDisc.value = 0;
  envScene.add(envSky);
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(envScene, 0.03).texture;
  scene.environmentIntensity = 0.6;
}

/* --------------------------------- jet & world --------------------------------- */

const jet = new F22(renderer, { livery: 'raptor' });
jet.update(0, true);
const world = buildGameWorld(renderer, jet.root);
scene.add(world.group, jet.root);
const physics = new GamePhysics(world);
$('loading').remove();

/* ------------------------------------ input ------------------------------------ */

const held = new Set();
const input = { pitch: 0, roll: 0, yaw: 0 };
const FLAPS = ['up', 'takeoff', 'landing'];
const CAMERAS = ['chase', 'cockpit', 'orbit'];
let camMode = 'chase';
let showControls = true;

function toast(msg, secs = 2.5) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), secs * 1000);
}

const ACTIONS = {
  g() {
    if (physics.s.onGround) return toast('Weight on wheels: gear stays down on the ground');
    physics.config.gearDown = !physics.config.gearDown;
    toast(`Gear ${physics.config.gearDown ? 'DOWN' : 'UP'}`);
  },
  f(e) {
    // F lowers the flaps one notch, Shift+F raises them
    const c = physics.config;
    const i = FLAPS.indexOf(c.flaps) + (e.shiftKey ? -1 : 1);
    c.flaps = FLAPS[clamp(i, 0, FLAPS.length - 1)];
    toast(`Flaps ${c.flaps.toUpperCase()}`);
  },
  b() {
    physics.config.speedBrake = !physics.config.speedBrake;
    toast(`Speed brake ${physics.config.speedBrake ? 'OUT' : 'IN'}`);
  },
  p() {
    physics.controls.parkingBrake = !physics.controls.parkingBrake;
    toast(`Parking brake ${physics.controls.parkingBrake ? 'SET' : 'RELEASED'}`);
  },
  x() {
    const c = physics.controls;
    c.afterburner = !c.afterburner;
    if (c.afterburner) c.throttle = 1;
    toast(`Afterburner ${c.afterburner ? 'ON' : 'OFF'}`);
  },
  o() {
    physics.config.bays = !physics.config.bays;
    toast(`Weapons bays ${physics.config.bays ? 'OPEN' : 'CLOSED'}`);
  },
  k() {
    physics.config.vectoring = !physics.config.vectoring;
    toast(`Thrust vectoring ${physics.config.vectoring ? 'ON' : 'OFF'}`);
  },
  c() {
    if (!physics.s.onGround || physics.speed > 2) return toast('Canopy opens only when stopped');
    jet.state.canopyOpen = !jet.state.canopyOpen;
  },
  v() {
    camMode = CAMERAS[(CAMERAS.indexOf(camMode) + 1) % CAMERAS.length];
    toast(`Camera: ${camMode}`);
  },
  h() {
    showControls = !showControls;
    $('controls').classList.toggle('hidden', !showControls);
  },
  r() {
    if (mission) startMission(mission.kind);
  },
};

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'tab'].includes(k)) e.preventDefault();
  if (k === 'escape') return togglePause();
  if (state !== 'flying') {
    if (k === 'enter' && state === 'debrief') startMission(mission.kind);
    return;
  }
  held.add(k);
  if (e.repeat) return;
  if (k === 'enter' && tutorial) tutorial.advanceInfo();
  if (ACTIONS[k]) ACTIONS[k](e);
});
addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));
addEventListener('blur', () => held.clear());

/** Keys push the control axes towards ±1; releasing springs them back to centre. */
function readControls(dt) {
  const axis = (name, minus, plus, rate) => {
    const want = (held.has(plus) ? 1 : 0) - (held.has(minus) ? 1 : 0);
    input[name] += clamp(want - input[name], -rate * dt, rate * dt);
  };
  axis('pitch', 'arrowup', 'arrowdown', 2.5); // ↓ pulls (nose up)
  axis('roll', 'arrowleft', 'arrowright', 4);
  axis('yaw', 'a', 'd', 3);
  const c = physics.controls;
  if (held.has('w')) c.throttle = Math.min(1, c.throttle + 0.45 * dt);
  if (held.has('s')) {
    c.throttle = Math.max(0, c.throttle - 0.45 * dt);
    c.afterburner = false;
  }
  c.brakes = held.has(' ');
  c.pitch = input.pitch;
  c.roll = input.roll;
  c.yaw = input.yaw;
}

/* ----------------------------------- cameras ----------------------------------- */

const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
let orbitYaw = 0.6;
let orbitPitch = 0.25;
let orbitDist = 28;
let dragging = null;
renderer.domElement.addEventListener('pointerdown', (e) => (dragging = { x: e.clientX, y: e.clientY }));
addEventListener('pointerup', () => (dragging = null));
addEventListener('pointermove', (e) => {
  if (!dragging) return;
  orbitYaw -= (e.clientX - dragging.x) * 0.005;
  orbitPitch = clamp(orbitPitch + (e.clientY - dragging.y) * 0.004, -0.4, 1.4);
  dragging = { x: e.clientX, y: e.clientY };
});
addEventListener('wheel', (e) => (orbitDist = clamp(orbitDist * (1 + e.deltaY * 0.001), 10, 200)), { passive: true });

function updateCamera(dt, snap = false) {
  const q = jet.root.quaternion;
  const centre = jet.root.position.clone().add(new THREE.Vector3(0, 2.2, 0));
  if (camMode === 'cockpit') {
    // pilot's eye: forward of the jet's origin and up, looking along the nose
    camera.position.copy(new THREE.Vector3(3.95, 3.2, 0).applyQuaternion(q).add(jet.root.position));
    camera.quaternion.copy(q).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2));
    camera.rotateX(-0.06);
    camera.near = 0.2;
    camera.updateProjectionMatrix();
    // HUD view: hide the cockpit interior and canopy so the panel doesn't block the runway
    jet.cockpit.crew.visible = jet.cockpit.interior.visible = jet.cockpit.canopyHinge.visible = false;
    return;
  }
  jet.cockpit.crew.visible = jet.cockpit.interior.visible = jet.cockpit.canopyHinge.visible = true;
  if (camera.near !== 1) {
    camera.near = 1;
    camera.updateProjectionMatrix();
  }
  let want;
  if (camMode === 'chase') {
    // behind and above along the flight path, rolling a little with the jet
    const back = new THREE.Vector3(-orbitDist, orbitDist * 0.28, 0).applyQuaternion(q);
    const flatBack = new THREE.Vector3(-orbitDist, 0, 0).applyQuaternion(q).setY(0).normalize().multiplyScalar(orbitDist);
    want = centre.clone().add(back.lerp(flatBack.setY(orbitDist * 0.25), 0.5));
  } else {
    want = centre.clone().add(new THREE.Vector3().setFromSphericalCoords(orbitDist, Math.PI / 2 - orbitPitch, orbitYaw));
  }
  const k = snap ? 1 : 1 - Math.exp(-dt * (camMode === 'chase' ? 6 : 12));
  camPos.lerp(want, k);
  camLook.lerp(centre, snap ? 1 : 1 - Math.exp(-dt * 12));
  const ground = world.groundAt(camPos.x, camPos.z) + 1.5;
  if (camPos.y < ground) camPos.y = ground;
  camera.position.copy(camPos);
  camera.up.set(0, 1, 0);
  camera.lookAt(camLook);
}

/* ------------------------------------- HUD ------------------------------------- */

const hud = $('hud');
const hctx = hud.getContext('2d');
const map = $('map');
const mctx = map.getContext('2d');

function sizeHud() {
  hud.width = innerWidth * devicePixelRatio;
  hud.height = innerHeight * devicePixelRatio;
}
sizeHud();

/** Green head-up display: pitch ladder and horizon, flight-path marker, speed and altitude tapes, heading. */
function drawHud() {
  const W = hud.width;
  const H = hud.height;
  const u = devicePixelRatio;
  hctx.clearRect(0, 0, W, H);
  if (state !== 'flying') return;
  const g = hctx;
  const green = 'rgba(120,255,150,0.92)';
  g.strokeStyle = green;
  g.fillStyle = green;
  g.lineWidth = 2 * u;
  g.font = `${14 * u}px ui-monospace, Menlo, monospace`;
  const cx = W / 2;
  const cy = H * 0.46;
  const pxPerDeg = (H / camera.fov) * 0.98;

  // attitude from the jet's orientation
  const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(jet.root.quaternion);
  const upv = new THREE.Vector3(0, 1, 0).applyQuaternion(jet.root.quaternion);
  const pitch = Math.asin(clamp(fwd.y, -1, 1)) / D2R;
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const bank = Math.atan2(upv.dot(right), upv.y); // positive = right wing down

  if (camMode !== 'orbit') {
    g.save();
    g.translate(cx, cy);
    g.rotate(-bank);
    for (let p = -90; p <= 90; p += 5) {
      const y = (pitch - p) * pxPerDeg;
      if (Math.abs(y) > H * 0.32) continue;
      const w = p === 0 ? W * 0.5 : p % 10 === 0 ? 120 * u : 50 * u;
      g.setLineDash(p < 0 ? [8 * u, 6 * u] : []);
      g.beginPath();
      g.moveTo(-w / 2, y);
      g.lineTo(-30 * u, y);
      g.moveTo(30 * u, y);
      g.lineTo(w / 2, y);
      g.stroke();
      if (p !== 0 && p % 10 === 0) {
        g.textAlign = 'right';
        g.fillText(String(p), -w / 2 - 6 * u, y + 5 * u);
      }
    }
    g.setLineDash([]);
    g.restore();
    // flight-path marker: where the jet is actually going
    const vel = physics.vel;
    if (vel.lengthSq() > 4) {
      const v = vel.clone().normalize();
      const fpPitch = Math.asin(clamp(v.y, -1, 1)) / D2R;
      const yaw = (Math.atan2(-v.z, v.x) - Math.atan2(-fwd.z, fwd.x)) / D2R;
      const mx = cx - ((yaw + 540) % 360 - 180) * pxPerDeg * 0.9;
      const my = cy + (pitch - fpPitch) * pxPerDeg;
      g.beginPath();
      g.arc(mx, my, 9 * u, 0, Math.PI * 2);
      g.moveTo(mx - 22 * u, my);
      g.lineTo(mx - 9 * u, my);
      g.moveTo(mx + 9 * u, my);
      g.lineTo(mx + 22 * u, my);
      g.moveTo(mx, my - 9 * u);
      g.lineTo(mx, my - 18 * u);
      g.stroke();
    }
    // waterline (nose)
    g.beginPath();
    g.moveTo(cx - 26 * u, cy);
    g.lineTo(cx - 10 * u, cy);
    g.lineTo(cx, cy + 8 * u);
    g.lineTo(cx + 10 * u, cy);
    g.lineTo(cx + 26 * u, cy);
    g.stroke();
  }

  // synthetic runway outlines: every runway within 25 km, drawn in the HUD so it's easy to find
  for (const ap of AIRPORTS) {
    const d = Math.hypot(physics.pos.x - ap.x, physics.pos.z - ap.z);
    if (d > 25000 || d < 1) continue;
    const h = ap.runway.heading;
    const L = ap.runway.length / 2;
    const Wd = ap.runway.width / 2;
    const dir = new THREE.Vector3(Math.cos(h), 0, -Math.sin(h));
    const side = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
    const corners = [[-L, -Wd], [L, -Wd], [L, Wd], [-L, Wd]].map(([a, b]) =>
      new THREE.Vector3(ap.x, ap.elev + 0.5, ap.z).addScaledVector(dir, a).addScaledVector(side, b).project(camera),
    );
    if (corners.some((c) => c.z > 1)) continue;
    g.beginPath();
    corners.forEach((c, i) => {
      const x = (c.x * 0.5 + 0.5) * W;
      const y = (-c.y * 0.5 + 0.5) * H;
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.closePath();
    g.stroke();
  }

  // speed (left) and altitude (right) boxes
  const kts = physics.speed * KT;
  const alt = physics.altitude * FT;
  const box = (x, text, label) => {
    g.textAlign = 'center';
    g.strokeRect(x - 52 * u, cy - 18 * u, 104 * u, 36 * u);
    g.font = `bold ${20 * u}px ui-monospace, Menlo, monospace`;
    g.fillText(text, x, cy + 7 * u);
    g.font = `${12 * u}px ui-monospace, Menlo, monospace`;
    g.fillText(label, x, cy + 34 * u);
  };
  box(cx - W * 0.22, kts.toFixed(0), 'KNOTS');
  box(cx + W * 0.22, alt.toFixed(0), 'FEET');
  g.font = `${13 * u}px ui-monospace, Menlo, monospace`;
  g.textAlign = 'center';
  g.fillText(`M ${(physics.speed / 340).toFixed(2)}   ${physics.s.nz.toFixed(1)} G`, cx - W * 0.22, cy + 54 * u);
  g.fillText(`VS ${((physics.s.vs || 0) * FT * 60).toFixed(0)} fpm`, cx + W * 0.22, cy + 54 * u);
  // heading
  g.font = `bold ${18 * u}px ui-monospace, Menlo, monospace`;
  g.fillText(`${String(Math.round(physics.headingDeg) % 360).padStart(3, '0')}°`, cx, H * 0.1);
  if (physics.s.stall) {
    g.fillStyle = 'rgba(255,90,70,0.95)';
    g.font = `bold ${26 * u}px system-ui, sans-serif`;
    g.fillText('STALL', cx, H * 0.18);
  }
  if (!physics.s.onGround && physics.s.agl < 300 && !physics.config.gearDown && physics.s.vs < -1) {
    g.fillStyle = 'rgba(255,190,70,0.95)';
    g.font = `bold ${22 * u}px system-ui, sans-serif`;
    g.fillText('GEAR!', cx, H * 0.24);
  }
}

function updateStatus() {
  const c = physics.controls;
  const cfg = physics.config;
  const s = physics.s;
  const bar = (v) => `<span class="bar"><i style="width:${(v * 100).toFixed(0)}%"></i></span>`;
  const flag = (on, text, cls = 'on') => `<span class="flag ${on ? cls : ''}">${text}</span>`;
  $('status').innerHTML = [
    `<div><b>THROTTLE</b> ${bar(c.throttle)} ${(c.throttle * 100).toFixed(0)}% ${flag(c.afterburner && c.throttle > 0.95, 'AB', 'hot')}</div>`,
    `<div>${flag(cfg.gearDown, `GEAR ${cfg.gearDown ? 'DN' : 'UP'}`)} ${flag(cfg.flaps !== 'up', `FLAPS ${cfg.flaps.toUpperCase()}`)} ${flag(cfg.speedBrake, 'SPD BRK', 'warn')}</div>`,
    `<div>${flag(c.parkingBrake, 'PARK BRK', 'warn')} ${flag(c.brakes, 'BRAKES', 'warn')} ${flag(cfg.bays, 'BAYS', 'warn')} ${flag(cfg.vectoring, 'TV')}</div>`,
    `<div class="dim">AoA ${(s.alpha / D2R).toFixed(0)}° · ${s.onGround ? 'ON GROUND' : `${(s.agl * FT).toFixed(0)} ft AGL`}${s.runway ? ` · ${s.runway.name}` : ''}</div>`,
  ].join('');
}

/** Top-down map: terrain-coloured backdrop, runways, the jet and the current waypoint. */
const mapBack = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 220;
  const g = c.getContext('2d');
  const img = g.createImageData(220, 220);
  for (let j = 0; j < 220; j++) {
    for (let i = 0; i < 220; i++) {
      const x = (i / 220 - 0.5) * 60000;
      const z = (j / 220 - 0.5) * 60000;
      const h = world.groundAt(x, z);
      const k = (j * 220 + i) * 4;
      const col = h < 0.5 ? [22, 50, 72] : h < 500 ? [70, 86, 52] : h < 1300 ? [110, 98, 74] : [190, 190, 192];
      img.data.set([...col, 255], k);
    }
  }
  g.putImageData(img, 0, 0);
  return c;
})();

function drawMap(target) {
  const g = mctx;
  const S = map.width;
  const scale = S / 60000;
  const toMap = (x, z) => [S / 2 + x * scale, S / 2 + z * scale];
  g.drawImage(mapBack, 0, 0, S, S);
  g.lineWidth = 3;
  g.strokeStyle = '#f3f3f3';
  for (const ap of AIRPORTS) {
    const h = ap.runway.heading;
    const L = ap.runway.length / 2;
    const [ax, az] = toMap(ap.x - Math.cos(h) * L, ap.z + Math.sin(h) * L);
    const [bx, bz] = toMap(ap.x + Math.cos(h) * L, ap.z - Math.sin(h) * L);
    g.beginPath();
    g.moveTo(ax, az);
    g.lineTo(bx, bz);
    g.stroke();
    g.fillStyle = '#fff';
    g.font = '10px system-ui';
    g.fillText(ap.name, ax + 4, az - 6);
  }
  if (target) {
    const [tx, tz] = toMap(target.x, target.z);
    g.fillStyle = '#4dff7c';
    g.beginPath();
    g.arc(tx, tz, 5, 0, Math.PI * 2);
    g.fill();
  }
  const [px, pz] = toMap(physics.pos.x, physics.pos.z);
  const hd = (physics.headingDeg - 90) * D2R;
  g.save();
  g.translate(px, pz);
  g.rotate(hd + Math.PI / 2);
  g.fillStyle = '#ffd24a';
  g.beginPath();
  g.moveTo(0, -8);
  g.lineTo(5, 6);
  g.lineTo(0, 3);
  g.lineTo(-5, 6);
  g.closePath();
  g.fill();
  g.restore();
}

/* ------------------------------ waypoint marker ------------------------------ */

const marker = new THREE.Mesh(
  new THREE.TorusGeometry(60, 6, 10, 40),
  new THREE.MeshBasicMaterial({ color: 0x4dff7c, transparent: true, opacity: 0.55, fog: false }),
);
marker.visible = false;
scene.add(marker);

function showWaypoint(target, label) {
  const el = $('waypoint');
  if (!target || state !== 'flying') {
    el.style.display = 'none';
    marker.visible = false;
    return;
  }
  marker.visible = true;
  marker.position.copy(target);
  marker.lookAt(camera.position);
  const dist = physics.pos.distanceTo(target);
  marker.scale.setScalar(clamp(dist / 2500, 1, 12));
  const p = target.clone().project(camera);
  const behind = p.z > 1;
  let x = (p.x * 0.5 + 0.5) * innerWidth;
  let y = (-p.y * 0.5 + 0.5) * innerHeight;
  if (behind) {
    x = innerWidth - x;
    y = innerHeight - 40;
  }
  el.style.display = 'block';
  el.style.left = `${clamp(x, 60, innerWidth - 60)}px`;
  el.style.top = `${clamp(y, 60, innerHeight - 60)}px`;
  el.textContent = `${label} · ${(dist / 1852).toFixed(1)} nm`;
}

/* ----------------------------------- missions ----------------------------------- */

let state = 'menu'; // menu | flying | paused | debrief
let mission = null;
let tutorial = null;
const ends = world.ends;
const homeEnd = ends.find((e) => e.airport.base && e.number === '09');
const lakeEnd = ends.find((e) => !e.airport.base && e.number === '06');

function lineUp(end) {
  const t = end.threshold;
  const along = 120; // a little past the threshold markings
  physics.reset({ x: t.x + Math.cos(end.heading) * along, z: t.y - Math.sin(end.heading) * along, heading: end.heading });
}

function startMission(kind) {
  mission = { kind, start: performance.now(), landed: null, target: null, label: '' };
  tutorial = null;
  physics.events.length = 0;
  jet.state.canopyOpen = false;
  if (kind === 'landing') {
    const g = lakeEnd.gate;
    physics.startAirborne({ x: g.x, y: g.y, z: g.z, heading: lakeEnd.heading, speed: 82, gearDown: true, flaps: 'landing', throttle: 0.3, path: -3 });
    mission.target = new THREE.Vector3(lakeEnd.touchdown.x, lakeEnd.airport.elev, lakeEnd.touchdown.y);
    mission.label = `Land: ${lakeEnd.name}`;
    setObjective('Landing challenge', `Follow the PAPI lights (2 white, 2 red) down to ${lakeEnd.name}. Gear and flaps are already down. Touch down gently, then hold <kbd>Space</kbd> to stop.`);
  } else {
    lineUp(homeEnd);
    if (kind === 'tutorial') {
      tutorial = makeTutorial();
    } else {
      setObjective('Free flight', `You're lined up on ${homeEnd.name}. Take off, explore, and land at either airport. The green ring marks the approach to ${lakeEnd.airport.name}.`);
      mission.target = lakeEnd.gate.clone();
      mission.label = `Approach ${lakeEnd.name}`;
    }
  }
  setState('flying');
  physics.step(0);
  syncJet(0);
  updateCamera(0, true);
}

function setObjective(title, html, progress = '') {
  $('objective').innerHTML = `<h3>${title}</h3><p>${html}</p>${progress ? `<div class="progress">${progress}</div>` : ''}`;
}

function makeTutorial() {
  let i = 0;
  let infoReady = false;
  const ctx = { physics, homeEnd, lakeEnd, jet };
  const show = () => {
    const step = TUTORIAL[i];
    infoReady = false;
    setObjective(`Tutorial ${i + 1}/${TUTORIAL.length}: ${step.title}`, step.text, step.info ? 'Press <kbd>Enter</kbd> to continue' : '');
    mission.target = step.target ? step.target(ctx) : null;
    mission.label = step.targetLabel || '';
    if (step.info) setTimeout(() => (infoReady = true), 400);
  };
  show();
  return {
    update() {
      const step = TUTORIAL[i];
      if (!step.info && step.done(ctx)) {
        toast('✔ ' + (step.success || 'Nice!'), 2);
        i++;
        if (i >= TUTORIAL.length) {
          finish('Tutorial complete', 'You can take off, fly and land the Raptor. Try the Landing Challenge or Free Flight next.', true);
          return;
        }
        show();
      }
    },
    advanceInfo() {
      if (TUTORIAL[i].info && infoReady) {
        i++;
        if (i >= TUTORIAL.length) return finish('Tutorial complete', '', true);
        show();
      }
    },
  };
}

function handleEvents() {
  while (physics.events.length) {
    const ev = physics.events.shift();
    if (ev.type === 'liftoff') toast(`Airborne at ${(ev.speed * KT).toFixed(0)} kt. Gear up with G`);
    if (ev.type === 'touchdown') {
      const where = ev.onRunway && ev.runway ? ev.runway.name : 'the grass';
      toast(`${ev.quality} touchdown on ${where}: ${(ev.sink * FT * 60).toFixed(0)} fpm`, 4);
      if (mission) mission.landed = ev;
    }
    if (ev.type === 'crash') finish('Crashed', ev.reason, false);
  }
  // a landing counts once the jet has stopped
  if (mission?.landed && physics.s.onGround && physics.speed < 1.5 && mission.kind !== 'tutorial') {
    const ev = mission.landed;
    const score = Math.max(0, Math.round(1000 - ev.sink * 180 - Math.max(0, ev.speed * KT - 150) * 6));
    finish('Landed!', `${ev.quality} touchdown on ${ev.runway ? ev.runway.name : 'the grass'} at ${(ev.speed * KT).toFixed(0)} kt, ${(ev.sink * FT * 60).toFixed(0)} fpm sink. Score: <b>${score}</b>`, true);
  }
}

function finish(title, text, good) {
  if (!good) camMode = 'chase';
  setState('debrief');
  $('debrief-title').textContent = title;
  $('debrief-title').className = good ? 'good' : 'bad';
  $('debrief-text').innerHTML = text;
}

function setState(s) {
  state = s;
  document.body.dataset.state = s;
  for (const id of ['menu', 'pause', 'debrief']) $(id).classList.toggle('hidden', !(s === id || (s === 'paused' && id === 'pause')));
  if (s !== 'flying') held.clear();
}

function togglePause() {
  if (state === 'flying') setState('paused');
  else if (state === 'paused') setState('flying');
}

for (const btn of document.querySelectorAll('[data-start]')) btn.addEventListener('click', () => startMission(btn.dataset.start));
$('resume').addEventListener('click', () => setState('flying'));
$('restart').addEventListener('click', () => startMission(mission.kind));
for (const btn of document.querySelectorAll('[data-menu]')) btn.addEventListener('click', () => setState('menu'));
$('retry').addEventListener('click', () => startMission(mission.kind));

/* ------------------------------------ loop ------------------------------------ */

function syncJet(dt) {
  jet.root.position.copy(physics.pos);
  jet.root.quaternion.copy(physics.quat);
  const S = jet.state;
  const c = physics.controls;
  const cfg = physics.config;
  Object.assign(S, {
    mach: physics.speed / 340,
    pitch: c.pitch,
    roll: c.roll,
    yaw: c.yaw,
    throttle: Math.max(0.15, c.throttle),
    afterburner: c.afterburner && c.throttle > 0.95 ? 1 : 0,
    gearDown: cfg.gearDown,
    flaps: cfg.flaps,
    speedBrake: cfg.speedBrake,
    mainBay: cfg.bays,
    sideBays: cfg.bays,
    thrustVectoring: cfg.vectoring,
  });
  jet.weightOnWheels = physics.s.onGround;
  jet.update(dt);
}

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (state === 'flying') {
    readControls(dt);
    physics.step(dt);
    handleEvents();
    tutorial?.update();
  }
  syncJet(state === 'flying' ? dt : 0);
  if (state === 'menu') {
    // slow orbit around the parked jet behind the menu
    const t = now / 1000;
    camera.position.copy(physics.pos).add(new THREE.Vector3(Math.cos(t * 0.1) * 26, 6, Math.sin(t * 0.1) * 26));
    camera.lookAt(physics.pos.clone().add(new THREE.Vector3(0, 2, 0)));
    camPos.copy(camera.position);
  } else {
    updateCamera(dt);
  }
  world.updatePapi(physics.pos);
  sun.target.position.copy(physics.pos);
  sun.position.copy(physics.pos).addScaledVector(sunDir, 150);
  renderer.render(scene, camera);
  drawHud();
  if (state === 'flying' || state === 'paused') {
    updateStatus();
    drawMap(mission?.target);
  }
  showWaypoint(mission?.target, mission?.label);
  requestAnimationFrame(frame);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  sizeHud();
});

lineUp(homeEnd);
setState('menu');
requestAnimationFrame(frame);

window.__game = { physics, jet, world, startMission, setState, get state() { return state; }, get mission() { return mission; }, ready: true };
