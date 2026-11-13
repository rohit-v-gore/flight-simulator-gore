import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { GamePhysics, AIRFRAMES } from './physics.js';
import { buildGameWorld } from './gameWorld.js';
import { buildTutorial } from './tutorial.js';

/*
 * Flight scenario game: choose an aircraft, a scenario and a route, then fly it.
 * Aircraft models load on demand (src/aircraft/*.js, see CONTRACT.md); physics.js flies them;
 * gameWorld.js is the United Coast map. This file wires input, cameras, HUD, missions and rendering.
 */

const D2R = Math.PI / 180;
const KT = 1.94384;
const FT = 3.28084;
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** Aircraft catalogue: loader + menu blurb. */
const AIRCRAFT = {
  f22: { load: () => import('../aircraft/f22.js'), blurb: 'Stealth fighter. Mach 2, 9 G, thrust vectoring, afterburner.' },
  concorde: { load: () => import('../aircraft/concorde.js'), blurb: 'Supersonic airliner. Mach 2 cruise on reheat-assisted Olympus engines.' },
  airliner: { load: () => import('../aircraft/airliner.js'), blurb: 'Narrow-body twinjet (A320-class). Subsonic, docile, big flaps.' },
  seaglider: { load: () => import('../aircraft/seaglider.js'), blurb: 'Electric wing-in-ground-effect craft. Hull, hydrofoil, flies at 30 ft over water.' },
};

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
scene.fog = new THREE.Fog(0xbccbd8, 14000, 70000);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 1, 150000);

const sky = new Sky();
sky.scale.setScalar(60000); // must stay inside the camera's far plane
sky.material.uniforms.turbidity.value = 3;
sky.material.uniforms.rayleigh.value = 1.2;
sky.material.uniforms.mieCoefficient.value = 0.004;
sky.material.uniforms.cloudCoverage.value = 0.25;
scene.add(sky);
const sunDir = new THREE.Vector3().setFromSphericalCoords(1, (90 - 38) * D2R, 140 * D2R);
sky.material.uniforms.sunPosition.value.copy(sunDir);
const sun = new THREE.DirectionalLight(0xfff4e6, 3.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 400 });
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

/* ------------------------------------ world ------------------------------------ */

const world = buildGameWorld(renderer);
scene.add(world.group);
const ends = world.ends;
const docks = world.spawns.docks;
$('loading').remove();

const models = {}; // loaded aircraft by id
let model = null; // current aircraft model (contract object)
let physics = null;

async function loadModel(id) {
  if (!models[id]) {
    const mod = await AIRCRAFT[id].load();
    models[id] = mod.create(renderer);
  }
  return models[id];
}

async function useAircraft(id) {
  const m = await loadModel(id);
  if (model && model !== m) scene.remove(model.root);
  model = m;
  scene.add(model.root);
  physics = new GamePhysics(world, id);
}

/* ------------------------------------ input ------------------------------------ */

const held = new Set();
const input = { pitch: 0, roll: 0, yaw: 0 };
const FLAPS = ['up', 'takeoff', 'landing'];
const CAMERAS = ['chase', 'cockpit', 'orbit'];
let camMode = 'chase';
let showControls = true;
let canopyOpen = false;

function toast(msg, secs = 2.5) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), secs * 1000);
}

const ACTIONS = {
  g() {
    const amph = physics.ac.amphibious;
    if (!amph && physics.s.onGround) return toast('Weight on wheels: gear stays down on the ground');
    physics.config.gearDown = !physics.config.gearDown;
    toast(`${amph ? 'Hydrofoil' : 'Gear'} ${physics.config.gearDown ? 'DOWN' : 'UP'}`);
  },
  f(e) {
    const c = physics.config;
    c.flaps = FLAPS[clamp(FLAPS.indexOf(c.flaps) + (e.shiftKey ? -1 : 1), 0, FLAPS.length - 1)];
    toast(`Flaps ${c.flaps.toUpperCase()}`);
  },
  b() {
    physics.config.speedBrake = !physics.config.speedBrake;
    toast(`Speed brake ${physics.config.speedBrake ? 'OUT' : 'IN'}`);
  },
  p() {
    if (physics.ac.amphibious) return toast('No parking brake on the water');
    physics.controls.parkingBrake = !physics.controls.parkingBrake;
    toast(`Parking brake ${physics.controls.parkingBrake ? 'SET' : 'RELEASED'}`);
  },
  x() {
    if (!physics.ac.afterburner) return toast(`The ${physics.ac.name} has no afterburner`);
    const c = physics.controls;
    c.afterburner = !c.afterburner;
    if (c.afterburner) c.throttle = 1;
    toast(`Afterburner ${c.afterburner ? 'ON' : 'OFF'}`);
  },
  o() {
    if (physics.type !== 'f22') return;
    physics.config.bays = !physics.config.bays;
    toast(`Weapons bays ${physics.config.bays ? 'OPEN' : 'CLOSED'}`);
  },
  k() {
    if (!physics.ac.vectoring) return toast('No thrust vectoring on this aircraft');
    physics.config.vectoring = !physics.config.vectoring;
    toast(`Thrust vectoring ${physics.config.vectoring ? 'ON' : 'OFF'}`);
  },
  c() {
    if (!physics.s.onGround || physics.speed > 2) return toast('Canopy / doors open only when stopped');
    canopyOpen = !canopyOpen;
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
    if (mission) startMission(mission.setup);
  },
};

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'tab'].includes(k)) e.preventDefault();
  if (k === 'escape') return togglePause();
  if (state !== 'flying') {
    if (k === 'enter' && state === 'debrief') startMission(mission.setup);
    return;
  }
  held.add(k);
  if (e.repeat) return;
  if (k === 'enter' && tutorial) tutorial.advanceInfo();
  if (ACTIONS[k]) ACTIONS[k](e);
});
addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));
addEventListener('blur', () => held.clear());

function readControls(dt) {
  const axis = (name, minus, plus, rate) => {
    const want = (held.has(plus) ? 1 : 0) - (held.has(minus) ? 1 : 0);
    input[name] += clamp(want - input[name], -rate * dt, rate * dt);
  };
  axis('pitch', 'arrowup', 'arrowdown', 2.5);
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
let zoom = 1;
let dragging = null;
renderer.domElement.addEventListener('pointerdown', (e) => (dragging = { x: e.clientX, y: e.clientY }));
addEventListener('pointerup', () => (dragging = null));
addEventListener('pointermove', (e) => {
  if (!dragging) return;
  orbitYaw -= (e.clientX - dragging.x) * 0.005;
  orbitPitch = clamp(orbitPitch + (e.clientY - dragging.y) * 0.004, -0.4, 1.4);
  dragging = { x: e.clientX, y: e.clientY };
});
addEventListener('wheel', (e) => (zoom = clamp(zoom * (1 + e.deltaY * 0.001), 0.35, 6)), { passive: true });

function setInteriorVisible(v) {
  if (model.jet) model.jet.cockpit.crew.visible = model.jet.cockpit.interior.visible = model.jet.cockpit.canopyHinge.visible = v;
  if (model.setCockpitView) model.setCockpitView(!v);
}

function updateCamera(dt, snap = false) {
  const q = model.root.quaternion;
  const dist = model.chaseDistance * zoom;
  const centre = model.root.position.clone().add(new THREE.Vector3(0, model.chaseDistance * 0.08, 0));
  if (camMode === 'cockpit') {
    camera.position.copy(new THREE.Vector3(...model.eye).applyQuaternion(q).add(model.root.position));
    camera.quaternion.copy(q).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2));
    camera.rotateX(-0.06);
    if (camera.near !== 0.2) {
      camera.near = 0.2;
      camera.updateProjectionMatrix();
    }
    setInteriorVisible(false);
    return;
  }
  setInteriorVisible(true);
  if (camera.near !== 1) {
    camera.near = 1;
    camera.updateProjectionMatrix();
  }
  let want;
  if (camMode === 'chase') {
    const back = new THREE.Vector3(-dist, dist * 0.28, 0).applyQuaternion(q);
    const flatBack = new THREE.Vector3(-dist, 0, 0).applyQuaternion(q).setY(0).normalize().multiplyScalar(dist);
    want = centre.clone().add(back.lerp(flatBack.setY(dist * 0.25), 0.5));
  } else {
    want = centre.clone().add(new THREE.Vector3().setFromSphericalCoords(dist, Math.PI / 2 - orbitPitch, orbitYaw));
  }
  const k = snap ? 1 : 1 - Math.exp(-dt * (camMode === 'chase' ? 6 : 12));
  camPos.lerp(want, k);
  camLook.lerp(centre, snap ? 1 : 1 - Math.exp(-dt * 12));
  const ground = Math.max(world.groundAt(camPos.x, camPos.z), 0) + 1.5;
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

function drawHud() {
  const W = hud.width;
  const H = hud.height;
  const u = devicePixelRatio;
  hctx.clearRect(0, 0, W, H);
  if (state !== 'flying' || !physics) return;
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
  const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(model.root.quaternion);
  const upv = new THREE.Vector3(0, 1, 0).applyQuaternion(model.root.quaternion);
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
  for (const ap of world.airports) {
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
  g.fillText(`M ${physics.s.mach.toFixed(2)}   ${physics.s.nz.toFixed(1)} G`, cx - W * 0.22, cy + 54 * u);
  g.fillText(`VS ${((physics.s.vs || 0) * FT * 60).toFixed(0)} fpm`, cx + W * 0.22, cy + 54 * u);
  // heading
  g.font = `bold ${18 * u}px ui-monospace, Menlo, monospace`;
  g.fillText(`${String(Math.round(physics.headingDeg) % 360).padStart(3, '0')}°`, cx, H * 0.1);
  if (physics.s.stall) {
    g.fillStyle = 'rgba(255,90,70,0.95)';
    g.font = `bold ${26 * u}px system-ui, sans-serif`;
    g.fillText('STALL', cx, H * 0.18);
  }
  if (!physics.ac.amphibious && !physics.s.onGround && physics.s.agl < 300 && !physics.config.gearDown && physics.s.vs < -1) {
    g.fillStyle = 'rgba(255,190,70,0.95)';
    g.font = `bold ${22 * u}px system-ui, sans-serif`;
    g.fillText('GEAR!', cx, H * 0.24);
  }
}


function updateStatus() {
  const c = physics.controls;
  const cfg = physics.config;
  const s = physics.s;
  const ac = physics.ac;
  const bar = (v) => `<span class="bar"><i style="width:${(v * 100).toFixed(0)}%"></i></span>`;
  const flag = (on, text, cls = 'on') => `<span class="flag ${on ? cls : ''}">${text}</span>`;
  const gearWord = ac.amphibious ? 'FOIL' : 'GEAR';
  const where = s.onGround ? (s.onWater ? (s.foilborne ? 'FOILBORNE' : 'ON THE WATER') : 'ON GROUND') : `${(s.agl * FT).toFixed(0)} ft AGL`;
  $('status').innerHTML = [
    `<div><b>${ac.name.toUpperCase()}</b></div>`,
    `<div><b>THROTTLE</b> ${bar(c.throttle)} ${(c.throttle * 100).toFixed(0)}% ${ac.afterburner ? flag(c.afterburner && c.throttle > 0.95, 'AB', 'hot') : ''}</div>`,
    `<div>${flag(cfg.gearDown, `${gearWord} ${cfg.gearDown ? 'DN' : 'UP'}`)} ${flag(cfg.flaps !== 'up', `FLAPS ${cfg.flaps.toUpperCase()}`)} ${flag(cfg.speedBrake, 'SPD BRK', 'warn')}</div>`,
    `<div>${ac.amphibious ? '' : flag(c.parkingBrake, 'PARK BRK', 'warn')} ${flag(c.brakes, ac.amphibious ? 'REVERSE' : 'BRAKES', 'warn')} ${physics.type === 'f22' ? flag(cfg.bays, 'BAYS', 'warn') + flag(cfg.vectoring, 'TV') : ''}</div>`,
    `<div class="dim">AoA ${(s.alpha / D2R).toFixed(0)}° · M ${s.mach.toFixed(2)} · ${where}${s.runway ? ` · ${s.runway.name}` : ''}</div>`,
  ].join('');
}

/** Map backdrop: terrain and water, with city names. */
const mapBack = (() => {
  const B = world.bounds;
  const W = 330;
  const H = Math.round(W * (B.z1 - B.z0) / (B.x1 - B.x0));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = B.x0 + (i / W) * (B.x1 - B.x0);
      const z = B.z0 + (j / H) * (B.z1 - B.z0);
      const h = world.groundAt(x, z);
      const col = h < 0.5 ? [24, 58, 84] : h < 600 ? [74, 92, 56] : h < 1700 ? [118, 104, 78] : h < 2700 ? [130, 124, 116] : [215, 218, 222];
      img.data.set([...col, 255], (j * W + i) * 4);
    }
  }
  g.putImageData(img, 0, 0);
  return c;
})();

function toMap(x, z) {
  const B = world.bounds;
  return [((x - B.x0) / (B.x1 - B.x0)) * map.width, ((z - B.z0) / (B.z1 - B.z0)) * map.height];
}

function drawMap(target) {
  const g = mctx;
  g.drawImage(mapBack, 0, 0, map.width, map.height);
  g.font = '600 15px system-ui';
  for (const c of world.cities) {
    const [x, z] = toMap(c.x, c.z);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(x, z, 4, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillText(c.name, x + 6, z - 6);
  }
  if (target) {
    const [tx, tz] = toMap(target.x, target.z);
    g.fillStyle = '#4dff7c';
    g.beginPath();
    g.arc(tx, tz, 7, 0, Math.PI * 2);
    g.fill();
  }
  const [px, pz] = toMap(physics.pos.x, physics.pos.z);
  g.save();
  g.translate(px, pz);
  g.rotate(physics.headingDeg * D2R);
  g.fillStyle = '#ffd24a';
  g.beginPath();
  g.moveTo(0, -11);
  g.lineTo(7, 8);
  g.lineTo(0, 4);
  g.lineTo(-7, 8);
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
  marker.scale.setScalar(clamp(dist / 2500, physics.ac.amphibious ? 0.4 : 1, 12));
  const p = target.clone().project(camera);
  let x = (p.x * 0.5 + 0.5) * innerWidth;
  let y = (-p.y * 0.5 + 0.5) * innerHeight;
  if (p.z > 1) {
    x = innerWidth - x;
    y = innerHeight - 40;
  }
  el.style.display = 'block';
  el.style.left = `${clamp(x, 60, innerWidth - 60)}px`;
  el.style.top = `${clamp(y, 60, innerHeight - 60)}px`;
  el.textContent = `${label} · ${(dist / 1852).toFixed(1)} nm`;
}

/* ----------------------------------- missions ----------------------------------- */

let state = 'menu';
let mission = null;
let tutorial = null;
const choice = { aircraft: 'f22', mode: 'tutorial', from: null, to: null };
try {
  Object.assign(choice, JSON.parse(localStorage.getItem('unitedCoast.choice') || '{}'));
  if (!AIRCRAFT[choice.aircraft]) choice.aircraft = 'f22';
} catch {
  /* storage unavailable: use the defaults */
}
const saveChoice = () => {
  try {
    localStorage.setItem('unitedCoast.choice', JSON.stringify(choice));
  } catch {
    /* ignore */
  }
};

/** Departure / destination options for the chosen aircraft: runway ends, or docks for the seaglider. */
function placesFor(id) {
  if (AIRFRAMES[id].amphibious) {
    return docks.map((d) => ({ key: `dock:${d.city.code}`, label: `${d.city.name} waterfront`, dock: d }));
  }
  return ends.map((e) => ({ key: `rwy:${e.airport.city.code}:${e.number}`, label: `${e.airport.city.name} (${e.airport.city.code}) · runway ${e.number}`, end: e }));
}

function destinationInfo(place) {
  if (place.end) {
    const e = place.end;
    return {
      name: `${e.airport.city.name} RWY ${e.number}`,
      gate: e.gate.clone(),
      touchdown: new THREE.Vector3(e.touchdown.x, e.airport.elev, e.touchdown.y),
      end: e,
    };
  }
  // seaglider: a landing area 4 km off the dock, approached along the dock's heading
  const d = place.dock;
  const back = 4000;
  const gate = new THREE.Vector3(d.x - Math.cos(d.heading) * back, 9, d.z + Math.sin(d.heading) * back);
  return { name: d.name, gate, touchdown: new THREE.Vector3(d.x, 0, d.z), dock: d };
}

async function startMission(setup) {
  setState('loading');
  await useAircraft(setup.aircraft);
  const ac = physics.ac;
  const places = placesFor(setup.aircraft);
  const from = places.find((p) => p.key === setup.from) || places[0];
  const to = places.find((p) => p.key === setup.to) || places.find((p) => p.key !== from.key);
  const dest = destinationInfo(to);
  mission = { setup, kind: setup.mode, landed: null, target: null, label: '', dest, ac };
  tutorial = null;
  canopyOpen = false;
  physics.events.length = 0;
  camMode = 'chase';
  if (setup.mode === 'landing') {
    if (ac.amphibious) {
      const d = dest.dock;
      const start = new THREE.Vector3(d.x - Math.cos(d.heading) * 7000, 9, d.z + Math.sin(d.heading) * 7000);
      physics.startAirborne({ x: start.x, y: start.y, z: start.z, heading: d.heading, speed: 40, gearDown: false, flaps: 'takeoff', throttle: 0.55 });
      mission.target = dest.touchdown.clone();
      setObjective(`Landing challenge: ${ac.name}`, `Settle onto the water near <b>${dest.name}</b> with the wings level and a gentle sink, then slow to a stop (<kbd>Space</kbd>).`);
    } else {
      const g = dest.gate;
      physics.startAirborne({ x: g.x, y: g.y, z: g.z, heading: dest.end.heading, speed: ac.vApproachKt / KT * 1.05, gearDown: true, flaps: 'landing', throttle: 0.3, path: -3 });
      tuneApproachThrottle();
      mission.target = dest.touchdown.clone();
      setObjective(`Landing challenge: ${ac.name}`, `Follow the PAPI (2 white, 2 red) down to <b>${dest.name}</b>. Gear and flaps are down; hold about ${ac.vApproachKt} kt. Flare, touch down, then hold <kbd>Space</kbd>.`);
    }
    mission.label = `Land: ${dest.name}`;
  } else {
    placeAt(from);
    if (setup.mode === 'tutorial') {
      tutorial = makeTutorial(ac, { depName: from.label, dest });
    } else {
      mission.target = ac.amphibious ? dest.gate : dest.gate;
      mission.label = `To ${dest.name}`;
      setObjective(`Free flight: ${ac.name}`, `From <b>${from.label}</b>. Fly anywhere and ${ac.amphibious ? 'land on any water' : 'land at any airport'}. The green ring marks the route to <b>${dest.name}</b>.`);
    }
  }
  setState('flying');
  physics.step(0);
  syncModel(0);
  updateCamera(0, true);
}

/** Pick the throttle that holds speed on the 3° glide path for the landing challenge. */
function tuneApproachThrottle() {
  const ac = physics.ac;
  const V = ac.vApproachKt / KT;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const t = (lo + hi) / 2;
    physics.controls.throttle = t;
    const cl = (ac.mass * 9.80665 * Math.cos(3 * D2R)) / (0.5 * 1.2 * V * V * ac.wingArea);
    const drag = 0.5 * 1.2 * V * V * ac.wingArea * physics.dragCoefficient(cl);
    const need = drag - ac.mass * 9.80665 * Math.sin(3 * D2R);
    if (physics.thrustNow(500) > need) hi = t;
    else lo = t;
  }
  physics.controls.throttle = (lo + hi) / 2;
}

function placeAt(place) {
  if (place.end) {
    const e = place.end;
    const along = 120;
    physics.reset({ x: e.threshold.x + Math.cos(e.heading) * along, z: e.threshold.y - Math.sin(e.heading) * along, heading: e.heading });
  } else {
    physics.reset({ x: place.dock.x, z: place.dock.z, heading: place.dock.heading });
  }
}

function setObjective(title, html, progress = '') {
  $('objective').innerHTML = `<h3>${title}</h3><p>${html}</p>${progress ? `<div class="progress">${progress}</div>` : ''}`;
}

function makeTutorial(ac, info) {
  const steps = buildTutorial(ac, { dest: info.dest, depName: info.depName });
  let i = 0;
  let infoReady = false;
  const ctx = { physics, ac };
  const show = () => {
    const step = steps[i];
    infoReady = false;
    setObjective(`Tutorial ${i + 1}/${steps.length}: ${step.title}`, step.text, step.info ? 'Press <kbd>Enter</kbd> to continue' : '');
    mission.target = step.target ? step.target(ctx) : null;
    mission.label = step.targetLabel || '';
    if (step.info) setTimeout(() => (infoReady = true), 400);
  };
  show();
  const next = () => {
    i++;
    if (i >= steps.length) return finish('Tutorial complete', `You can fly the ${ac.name}. Try Free flight or the Landing challenge next, or pick another aircraft.`, true);
    show();
  };
  return {
    update() {
      const step = steps[i];
      if (step && !step.info && step.done(ctx)) {
        toast(`✔ ${step.success || 'Nice!'}`, 2);
        next();
      }
    },
    advanceInfo() {
      if (steps[i]?.info && infoReady) next();
    },
  };
}

function handleEvents() {
  while (physics.events.length) {
    const ev = physics.events.shift();
    if (ev.type === 'liftoff') toast(`Airborne at ${(ev.speed * KT).toFixed(0)} kt${physics.ac.amphibious ? '' : '. Gear up with G'}`);
    if (ev.type === 'touchdown') {
      const where = ev.onWater ? 'the water' : ev.runway ? ev.runway.name : 'the grass';
      toast(`${ev.quality} touchdown on ${where}: ${(ev.sink * FT * 60).toFixed(0)} fpm`, 4);
      if (mission) mission.landed = { ...ev, where };
    }
    if (ev.type === 'crash') finish('Crashed', ev.reason, false);
  }
  if (mission?.landed && physics.s.onGround && physics.speed < 1.5 && mission.kind !== 'tutorial') {
    const ev = mission.landed;
    const ac = physics.ac;
    const score = Math.max(0, Math.round(1000 - (ev.sink / ac.maxTouchdownVS) * 500 - Math.max(0, ev.speed * KT - (ac.vApproachKt + 10)) * 6));
    finish('Landed!', `${ev.quality} touchdown on ${ev.where} at ${(ev.speed * KT).toFixed(0)} kt, ${(ev.sink * FT * 60).toFixed(0)} fpm sink. Score: <b>${score}</b>`, true);
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
  $('menu').classList.toggle('hidden', s !== 'menu');
  $('pause').classList.toggle('hidden', s !== 'paused');
  $('debrief').classList.toggle('hidden', s !== 'debrief');
  if (s !== 'flying') held.clear();
}

function togglePause() {
  if (state === 'flying') setState('paused');
  else if (state === 'paused') setState('flying');
}

/* ------------------------------------ menu ------------------------------------ */

function renderMenu() {
  for (const el of document.querySelectorAll('[data-aircraft]')) el.classList.toggle('selected', el.dataset.aircraft === choice.aircraft);
  for (const el of document.querySelectorAll('[data-mode]')) el.classList.toggle('selected', el.dataset.mode === choice.mode);
  const places = placesFor(choice.aircraft);
  const fill = (sel, value) => {
    sel.innerHTML = places.map((p) => `<option value="${p.key}">${p.label}</option>`).join('');
    sel.value = places.some((p) => p.key === value) ? value : places[0].key;
  };
  fill($('from'), choice.from);
  choice.from = $('from').value;
  // default destination: the next city along (never the departure city)
  const city = (key) => key.split(':')[1];
  const fromIdx = places.findIndex((p) => p.key === choice.from);
  const defaultTo = places.slice(fromIdx + 1).concat(places).find((p) => city(p.key) !== city(choice.from));
  fill($('to'), choice.to && city(choice.to) !== city(choice.from) ? choice.to : defaultTo.key);
  choice.to = $('to').value;
  $('from-row').classList.toggle('hidden', choice.mode === 'landing');
  $('blurb').textContent = AIRCRAFT[choice.aircraft].blurb;
  previewMenuAircraft();
}

async function previewMenuAircraft() {
  const id = choice.aircraft;
  await useAircraft(id);
  if (choice.aircraft !== id) return;
  placeAt(placesFor(id).find((p) => p.key === choice.from) || placesFor(id)[0]);
  syncModel(0);
}

for (const el of document.querySelectorAll('[data-aircraft]')) el.addEventListener('click', () => {
  choice.aircraft = el.dataset.aircraft;
  choice.from = choice.to = null;
  renderMenu();
});
for (const el of document.querySelectorAll('[data-mode]')) el.addEventListener('click', () => {
  choice.mode = el.dataset.mode;
  renderMenu();
});
$('from').addEventListener('change', (e) => {
  choice.from = e.target.value;
  renderMenu();
});
$('to').addEventListener('change', (e) => (choice.to = e.target.value));
$('go').addEventListener('click', () => {
  saveChoice();
  startMission({ ...choice });
});
$('resume').addEventListener('click', () => setState('flying'));
$('restart').addEventListener('click', () => startMission(mission.setup));
for (const btn of document.querySelectorAll('[data-menu]')) btn.addEventListener('click', () => {
  setState('menu');
  renderMenu();
});
$('retry').addEventListener('click', () => startMission(mission.setup));

/* ------------------------------------ loop ------------------------------------ */

function syncModel(dt) {
  if (!model || !physics) return;
  model.root.position.copy(physics.pos);
  model.root.quaternion.copy(physics.quat);
  const c = physics.controls;
  const cfg = physics.config;
  model.update(dt, {
    gearDown: cfg.gearDown,
    flaps: cfg.flaps,
    throttle: c.throttle,
    afterburner: physics.ac.afterburner && c.afterburner && c.throttle > 0.95 ? 1 : 0,
    pitch: c.pitch,
    roll: c.roll,
    yaw: c.yaw,
    speedBrake: cfg.speedBrake || (physics.s.onGround && c.brakes),
    onGround: physics.s.onGround,
    speed: physics.speed,
    time: physics.s.time,
    bays: cfg.bays,
    vectoring: cfg.vectoring,
    canopyOpen,
  });
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
  syncModel(state === 'flying' ? dt : 0);
  if (model) {
    if (state === 'menu' || state === 'loading') {
      const t = now / 1000;
      const d = model.chaseDistance * 1.05;
      camera.position.copy(physics.pos).add(new THREE.Vector3(Math.cos(t * 0.1) * d, d * 0.22, Math.sin(t * 0.1) * d));
      camera.lookAt(physics.pos.clone().add(new THREE.Vector3(0, d * 0.08, 0)));
      camPos.copy(camera.position);
      camLook.copy(physics.pos);
    } else {
      updateCamera(dt);
    }
    world.updatePapi(physics.pos);
    sun.target.position.copy(physics.pos);
    sun.position.copy(physics.pos).addScaledVector(sunDir, 200);
    const s = Math.max(45, model.chaseDistance * 1.4);
    if (sun.shadow.camera.right !== s) {
      Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
      sun.shadow.camera.updateProjectionMatrix();
    }
  }
  sky.position.copy(camera.position); // the sky dome travels with the viewer
  renderer.render(scene, camera);
  drawHud();
  if (physics && (state === 'flying' || state === 'paused')) {
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

setState('menu');
renderMenu();
requestAnimationFrame(frame);

window.__game = {
  get physics() { return physics; },
  get model() { return model; },
  world,
  choice,
  startMission,
  setState,
  get state() { return state; },
  get mission() { return mission; },
  ready: true,
};
