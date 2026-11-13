import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import GUI from 'lil-gui';

// Model preview for developing aircraft modules: ?model=<file in src/aircraft without .js>
const id = new URLSearchParams(location.search).get('model') || 'f22';
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.6;
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.2, 20000);
const controls = new OrbitControls(camera, renderer.domElement);
const sky = new Sky();
sky.scale.setScalar(10000);
const sunDir = new THREE.Vector3().setFromSphericalCoords(1, (90 - 40) * Math.PI / 180, 2.2);
sky.material.uniforms.sunPosition.value.copy(sunDir);
scene.add(sky);
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, far: 400 });
sun.position.copy(sunDir).multiplyScalar(150);
scene.add(sun, new THREE.HemisphereLight(0xc4dcff, 0x5d5446, 0.6));
const env = new THREE.Scene();
const s2 = new Sky();
s2.scale.setScalar(500);
s2.material.uniforms.sunPosition.value.copy(sunDir);
env.add(s2);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(env, 0.03).texture;
scene.environmentIntensity = 0.6;
const ground = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), new THREE.MeshStandardMaterial({ color: 0x7d7b74, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const t0 = performance.now();
const mod = await import(`./${id}.js`);
const ac = mod.create(renderer);
const buildMs = performance.now() - t0;
scene.add(ac.root);
let tris = 0;
ac.root.traverse((o) => {
  if (o.isMesh && o.geometry) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1);
});
const box = new THREE.Box3().setFromObject(ac.root);
const size = box.getSize(new THREE.Vector3());
document.getElementById('info').innerHTML = `<b>${ac.name}</b> · build ${buildMs.toFixed(0)} ms · ${(tris / 1000).toFixed(0)}k tris · L ${size.x.toFixed(1)} × H ${size.y.toFixed(1)} × span ${size.z.toFixed(1)} m · min y ${box.min.y.toFixed(2)}`;
const d = Math.max(size.x, size.z);
camera.position.set(d * 0.8, d * 0.35, d * 0.9);
controls.target.set(0, size.y * 0.35, 0);

const s = { gearDown: true, flaps: 'up', throttle: 0.3, afterburner: 0, pitch: 0, roll: 0, yaw: 0, speedBrake: false, onGround: true, speed: 0, time: 0 };
const gui = new GUI();
gui.add(s, 'gearDown');
gui.add(s, 'flaps', ['up', 'takeoff', 'landing']);
gui.add(s, 'throttle', 0, 1, 0.01);
gui.add(s, 'afterburner', 0, 1, 0.01);
gui.add(s, 'pitch', -1, 1, 0.01);
gui.add(s, 'roll', -1, 1, 0.01);
gui.add(s, 'yaw', -1, 1, 0.01);
gui.add(s, 'speedBrake');
gui.add(s, 'onGround');
gui.add(s, 'speed', 0, 700, 1);
const views = { side: () => setCam([0.01, size.y * 0.5, d * 1.3]), front: () => setCam([d * 1.3, size.y * 0.5, 0.01]), top: () => setCam([0.01, d * 1.5, 0.02]), threeQuarter: () => setCam([d * 0.8, d * 0.35, d * 0.9]), cockpit: () => { camera.position.set(...ac.eye); controls.target.set(ac.eye[0] + 10, ac.eye[1] - 0.5, ac.eye[2]); } };
function setCam(p) { camera.position.set(...p); controls.target.set(0, size.y * 0.35, 0); }
for (const k of Object.keys(views)) gui.add(views, k);
window.__preview = { ac, s, views, camera, controls, ready: true };

let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  s.time += dt;
  ac.update(dt, s);
  controls.update();
  renderer.render(scene, camera);
});
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
