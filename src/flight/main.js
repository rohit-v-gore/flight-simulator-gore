/*
 * flight.html: the procedural F-22 flying over real terrain in CesiumJS.
 *
 * Cesium (loaded from its CDN as the global `Cesium`) draws the globe; the jet is exported once to
 * GLB and then animated node by node from a live three.js copy, which the flight model and the
 * demo pilot drive through the same state object the Three.js viewer uses.
 */
import { exportJet } from './exportModel.js';
import { FlightModel, D2R, clamp } from './flightModel.js';
import { DemoPilot, EDWARDS } from './autopilot.js';

const Cesium = window.Cesium;
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const status = (msg, err = false) => {
  $('status').textContent = msg;
  $('status').classList.toggle('err', err);
};

const KT = 1.943844;
const FT = 3.28084;
const EYE = [4.2, 0, 2.95]; // pilot's eye in the model frame: x forward, y left, z up (metres)
const CAMS = ['chase', 'cockpit', 'flyby', 'free'];

async function main() {
  if (!Cesium) throw new Error('CesiumJS did not load (check the network connection).');
  const token = import.meta.env.VITE_CESIUM_ION_TOKEN;
  if (token) Cesium.Ion.defaultAccessToken = token;

  status('Loading terrain…');
  const viewer = new Cesium.Viewer('globe', {
    animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false,
    sceneModePicker: false, navigationHelpButton: false, infoBox: false, selectionIndicator: false,
    fullscreenButton: false, shadows: params.get('shadows') !== '0',
  });
  const scene = viewer.scene;
  const camera = viewer.camera;
  scene.globe.depthTestAgainstTerrain = true;
  scene.globe.enableLighting = true;
  scene.fog.density = 1.4e-4;
  viewer.terrainProvider = await Cesium.createWorldTerrainAsync();
  viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(params.get('time') || '2026-06-15T18:30:00Z');
  viewer.clock.shouldAnimate = false;

  const rw = EDWARDS;
  const [vLat, vLon] = rw.point(-rw.length / 2 - 250, -120);
  camera.setView({
    destination: Cesium.Cartesian3.fromRadians(vLon, vLat, rw.elevation + 60),
    orientation: { heading: rw.heading - 0.3, pitch: -0.12, roll: 0 },
  });
  try {
    const [c] = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [Cesium.Cartographic.fromRadians(rw.lon, rw.lat)]);
    if (Number.isFinite(c.height)) rw.elevation = c.height;
  } catch (e) {
    console.warn('[flight] runway elevation sampling failed; using the built-in value', e);
  }
  if (params.get('buildings') !== '0') {
    try {
      scene.primitives.add(await Cesium.createOsmBuildingsAsync());
    } catch (e) {
      console.warn('[flight] OSM buildings unavailable', e);
    }
  }

  /* ---------------- jet ---------------- */
  status('Building the F-22…');
  const { glb, jet, nodes } = await exportJet({ livery: params.get('livery') || 'raptor' });
  const url = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
  const model = await Cesium.Model.fromGltfAsync({
    url,
    upAxis: Cesium.Axis.Y,
    forwardAxis: Cesium.Axis.X,
    shadows: Cesium.ShadowMode.ENABLED,
  });
  scene.primitives.add(model);
  await new Promise((resolve) => model.readyEvent.addEventListener(resolve));

  // pair glTF nodes with the three.js objects that animate them
  const links = [];
  for (const [name, obj] of nodes) {
    const node = model.getNode(name);
    if (node) links.push({ node, obj, last: null, shown: true });
  }
  const crew = jet.cockpit.crew;
  const syncNodes = (hideCrew) => {
    jet.root.updateMatrixWorld(true);
    for (const l of links) {
      const e = l.obj.matrix.elements;
      if (!l.last || e.some((v, i) => v !== l.last[i])) {
        l.node.matrix = Cesium.Matrix4.fromArray(e);
        l.last = e.slice();
      }
      const show = l.obj.visible && !(hideCrew && l.obj === crew);
      if (show !== l.shown) {
        l.node.show = show;
        l.shown = show;
      }
    }
  };

  /* ---------------- flight model + pilots ---------------- */
  let lastGround = rw.elevation;
  const carto = new Cesium.Cartographic();
  const groundHeight = (lat, lon) => {
    if (rw.contains(lat, lon)) return rw.elevation;
    carto.latitude = lat;
    carto.longitude = lon;
    const h = scene.globe.getHeight(carto);
    if (Number.isFinite(h)) lastGround = h;
    return lastGround;
  };
  const fm = new FlightModel({ groundHeight });
  let bannerTimer = 0;
  const say = (msg, secs = 5) => {
    $('banner').textContent = msg;
    $('banner').style.opacity = 1;
    bannerTimer = secs;
  };
  const demo = new DemoPilot(fm, rw, { say });
  let mode = params.get('mode') === 'manual' ? 'manual' : 'demo';
  let canopyOpen = false;
  let crashT = 0;
  let timeScale = 1;
  const restart = () => {
    demo.restart();
    canopyOpen = false;
    crashT = 0;
    if (mode === 'manual') {
      fm.controls.throttle = 0.3;
      say('Manual: runway 04R. W/A for power, ↓ to rotate at ~135 kt', 7);
    }
  };
  restart();

  /* ---------------- keyboard ---------------- */
  const held = new Set();
  const flying = new Set(['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'q', 'e', 'w', 's', 'a', ' ']);
  const takeControl = () => {
    if (mode === 'demo') {
      mode = 'manual';
      say('You have control', 3);
    }
  };
  addEventListener('keydown', (ev) => {
    const k = ev.key.toLowerCase();
    if (k.startsWith('arrow') || k === ' ') ev.preventDefault();
    if (held.has(k)) return;
    held.add(k);
    const cfg = fm.config;
    const s = fm.s;
    if (flying.has(k) || 'gfbok'.includes(k)) takeControl();
    switch (k) {
      case 'a':
        fm.controls.afterburner = !fm.controls.afterburner;
        if (fm.controls.afterburner) fm.controls.throttle = 1;
        break;
      case 'g':
        if (s.onGround) say('Weight on wheels: gear stays down', 3);
        else cfg.gearDown = !cfg.gearDown;
        break;
      case 'f':
        cfg.flaps = { up: 'takeoff', takeoff: 'landing', landing: 'up' }[cfg.flaps];
        say(`Flaps ${cfg.flaps}`, 2);
        break;
      case 'b':
        cfg.speedBrake = !cfg.speedBrake;
        break;
      case 'o':
        cfg.bays = !cfg.bays;
        say(`Weapons bays ${cfg.bays ? 'open' : 'closed'}`, 2);
        break;
      case 'k':
        cfg.vectoring = !cfg.vectoring;
        say(`Thrust vectoring ${cfg.vectoring ? 'on' : 'off'}`, 2);
        break;
      case 'c':
        if (s.onGround && s.V < 2) canopyOpen = !canopyOpen;
        else say('Canopy: only when stopped on the ground', 3);
        break;
      case 'v':
        setCam(CAMS[(CAMS.indexOf(cam) + 1) % CAMS.length]);
        break;
      case 'p':
        mode = mode === 'demo' ? 'manual' : 'demo';
        if (mode === 'demo') restart();
        else say('You have control', 3);
        break;
      case 't':
        timeScale = timeScale === 1 ? 2 : timeScale === 2 ? 4 : 1;
        say(`Time ×${timeScale}`, 2);
        break;
      case 'r':
        restart();
        break;
      case 'h':
        $('help').classList.toggle('hidden');
        break;
      default:
    }
  });
  addEventListener('keyup', (ev) => held.delete(ev.key.toLowerCase()));
  addEventListener('blur', () => held.clear());

  const stick = { pitch: 0, roll: 0, yaw: 0 };
  function manualInputs(dt) {
    const c = fm.controls;
    const axis = (name, neg, pos, rate) => {
      const target = (held.has(pos) ? 1 : 0) - (held.has(neg) ? 1 : 0);
      stick[name] += clamp(target - stick[name], -rate * dt, rate * dt);
      c[name] = stick[name];
    };
    axis('pitch', 'arrowup', 'arrowdown', 2.5);
    axis('roll', 'arrowleft', 'arrowright', 4);
    axis('yaw', 'q', 'e', 3);
    if (held.has('w')) c.throttle = Math.min(1, c.throttle + 0.5 * dt);
    if (held.has('s')) {
      c.throttle = Math.max(0, c.throttle - 0.5 * dt);
      c.afterburner = false;
    }
    c.brakes = held.has(' ') || (fm.s.onGround && c.throttle < 0.05 && fm.s.V < 3);
  }

  /* ---------------- placement + cameras ---------------- */
  const pos = new Cesium.Cartesian3();
  const hpr = new Cesium.HeadingPitchRoll();
  const modelM = new Cesium.Matrix4();
  let cam = params.get('camera') || 'chase';
  let chaseRange = 42;
  let chaseHdg = null;
  let flybyAt = null;
  function setCam(c) {
    cam = CAMS.includes(c) ? c : 'chase';
    flybyAt = null;
    chaseHdg = null;
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    scene.screenSpaceCameraController.enableInputs = cam === 'free';
    say(`Camera: ${cam}`, 2);
  }
  setCam(cam);
  viewer.canvas.addEventListener('wheel', (e) => {
    if (cam === 'chase') chaseRange = clamp(chaseRange * (e.deltaY > 0 ? 1.1 : 0.9), 14, 400);
  }, { passive: true });

  function place() {
    const s = fm.s;
    Cesium.Cartesian3.fromRadians(s.lon, s.lat, s.h, undefined, pos);
    hpr.heading = s.psi - Math.PI / 2; // Cesium heading 0 = model +X pointing east
    hpr.pitch = s.theta;
    hpr.roll = s.phi;
    Cesium.Transforms.headingPitchRollToFixedFrame(pos, hpr, Cesium.Ellipsoid.WGS84, undefined, modelM);
    model.modelMatrix = modelM;
  }

  const tmp = new Cesium.Cartesian3();
  function updateCamera(dt) {
    const s = fm.s;
    const centre = Cesium.Matrix4.multiplyByPoint(modelM, new Cesium.Cartesian3(0, 0, 2.2), new Cesium.Cartesian3());
    if (cam === 'chase') {
      chaseHdg = chaseHdg === null ? s.psi : chaseHdg + Math.atan2(Math.sin(s.psi - chaseHdg), Math.cos(s.psi - chaseHdg)) * (1 - Math.exp(-2.5 * dt));
      camera.lookAt(centre, new Cesium.HeadingPitchRange(chaseHdg, -0.2, chaseRange));
    } else if (cam === 'cockpit') {
      const eye = Cesium.Matrix4.multiplyByPoint(modelM, Cesium.Cartesian3.fromArray(EYE), new Cesium.Cartesian3());
      const fwd = Cesium.Matrix4.multiplyByPointAsVector(modelM, new Cesium.Cartesian3(1, 0, -0.1), new Cesium.Cartesian3());
      const up = Cesium.Matrix4.multiplyByPointAsVector(modelM, Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3());
      camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      camera.setView({ destination: eye, orientation: { direction: Cesium.Cartesian3.normalize(fwd, fwd), up } });
    } else if (cam === 'flyby') {
      const enu = Cesium.Transforms.eastNorthUpToFixedFrame(centre);
      const ahead = Cesium.Matrix4.multiplyByPointAsVector(enu, new Cesium.Cartesian3(Math.sin(s.psi), Math.cos(s.psi), 0), new Cesium.Cartesian3());
      const passed = flybyAt && Cesium.Cartesian3.dot(Cesium.Cartesian3.subtract(flybyAt, centre, tmp), ahead) < -Math.max(150, s.V * 2);
      if (!flybyAt || passed || Cesium.Cartesian3.distance(flybyAt, centre) > 8000) {
        const lead = clamp(s.V * 4, 80, 1400);
        const side = new Cesium.Cartesian3(Math.cos(s.psi) * 40 + Math.sin(s.psi) * lead, -Math.sin(s.psi) * 40 + Math.cos(s.psi) * lead, -4);
        flybyAt = Cesium.Matrix4.multiplyByPoint(enu, side, new Cesium.Cartesian3());
        const c = Cesium.Cartographic.fromCartesian(flybyAt);
        const gh = scene.globe.getHeight(c);
        if (Number.isFinite(gh) && c.height < gh + 3) {
          c.height = gh + 3;
          flybyAt = Cesium.Cartographic.toCartesian(c);
        }
      }
      const dir = Cesium.Cartesian3.normalize(Cesium.Cartesian3.subtract(centre, flybyAt, new Cesium.Cartesian3()), new Cesium.Cartesian3());
      const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(flybyAt, new Cesium.Cartesian3());
      const right = Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(dir, up, new Cesium.Cartesian3()), new Cesium.Cartesian3());
      camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      camera.setView({ destination: flybyAt, orientation: { direction: dir, up: Cesium.Cartesian3.cross(right, dir, new Cesium.Cartesian3()) } });
    }
  }

  /* ---------------- HUD ---------------- */
  const hudLine = (k, v) => `<span class="k">${k}</span>${v}`;
  function drawHud() {
    const s = fm.s;
    const c = fm.controls;
    const cfg = fm.config;
    const gear = jet.pos.gear > 0.99 ? 'DOWN' : jet.pos.gear < 0.01 ? 'UP' : 'TRANSIT';
    const lines = [
      `<div class="title">F-22A RAPTOR · ${mode === 'demo' ? 'DEMO' : 'MANUAL'} · ${cam.toUpperCase()}${timeScale > 1 ? ` · ×${timeScale}` : ''}</div>`,
      hudLine('IAS', `${(s.V * KT).toFixed(0).padStart(4)} kt   M ${fm.mach.toFixed(2)}`),
      hudLine('ALT', `${((s.h - rw.elevation) * FT + 2300).toFixed(0).padStart(5)} ft   AGL ${(s.agl * FT).toFixed(0)}`),
      hudLine('HDG', `${((s.psi / D2R + 360) % 360).toFixed(0).padStart(3, '0')}°    VS ${(s.vs * FT * 60).toFixed(0)} fpm`),
      hudLine('G', `${s.n.toFixed(1).padStart(4)}    AoA ${(s.alpha / D2R).toFixed(0)}°  BANK ${(s.phi / D2R).toFixed(0)}°`),
      hudLine('THR', `${(c.throttle * 100).toFixed(0).padStart(3)}%${c.afterburner ? '  AFTERBURNER' : ''}`),
      hudLine('TV', `${jet.pos.vector.toFixed(0).padStart(3)}°  ${cfg.vectoring ? 'ON' : 'OFF'}   BAYS ${cfg.bays ? 'OPEN' : 'SHUT'}`),
      hudLine('GEAR', `${gear}  FLAPS ${cfg.flaps.toUpperCase()}  SB ${cfg.speedBrake ? 'OUT' : 'IN'}${c.brakes && s.onGround ? '  BRK' : ''}`),
    ];
    if (s.onGround) lines.push('<span class="warn">WEIGHT ON WHEELS</span>');
    if (s.crashed) lines.push('<span class="warn">CRASHED — restarting</span>');
    $('hud').innerHTML = lines.join('<br>');
  }

  /* ---------------- frame loop ---------------- */
  let last = performance.now();
  let hudT = 0;
  scene.preUpdate.addEventListener(() => {
    const now = performance.now();
    const realDt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const dt = realDt * timeScale;

    if (mode === 'demo') {
      demo.update(dt);
      canopyOpen = demo.canopy;
      if (demo.done) restart();
    } else manualInputs(realDt);
    fm.step(dt);
    for (const ev of fm.events.splice(0)) {
      if (ev === 'crash') say('Crashed!', 3);
      else if (mode === 'manual') say(ev === 'liftoff' ? 'Liftoff' : 'Touchdown', 2);
    }
    if (fm.s.crashed && (crashT += realDt) > 3) restart();

    // drive the 3D model's systems from the flight state
    const S = jet.state;
    const c = fm.controls;
    const cfg = fm.config;
    jet.weightOnWheels = fm.s.onGround;
    Object.assign(S, {
      mach: fm.mach,
      flaps: cfg.flaps,
      gearDown: cfg.gearDown,
      speedBrake: cfg.speedBrake,
      mainBay: cfg.bays,
      sideBays: cfg.bays,
      thrustVectoring: cfg.vectoring,
      throttle: Math.max(0.15, c.throttle),
      afterburner: c.afterburner ? 1 : 0,
      // stabilators and nozzles also carry the nose-up trim needed at high angle of attack
      pitch: clamp(c.pitch + Math.max(0, fm.s.alpha - 10 * D2R) / (18 * D2R), -1, 1),
      roll: clamp(c.roll, -1, 1) * 0.7,
      yaw: clamp(c.yaw, -1, 1) * 0.6,
      canopyOpen,
      lights: true,
    });
    jet.update(dt);
    syncNodes(cam === 'cockpit');
    place();
    updateCamera(realDt);

    if (bannerTimer > 0 && (bannerTimer -= realDt) <= 0) $('banner').style.opacity = 0;
    if ((hudT -= realDt) <= 0) {
      hudT = 0.1;
      drawHud();
    }
  });

  status('');
  say(mode === 'demo' ? 'Demo sortie from Edwards AFB. Press P to fly it yourself' : 'Manual: runway 04R', 6);
  window.__flight = { viewer, model, jet, fm, demo, setCam, ready: true };
}

main().catch((e) => {
  console.error(e);
  status(`Could not start the flight:\n${e.message}`, true);
});
