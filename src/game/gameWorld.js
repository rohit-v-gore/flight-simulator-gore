import * as THREE from 'three';
import { fbm, hash2, grassTex, asphaltTex, concreteTexture, glowTex, textPlane, paintMat, box, tower, windsock } from '../world/world.js';

/*
 * "United Coast": a composite continent of eight major US cities ringed by ocean, with a Great Lake,
 * a bay with a suspension bridge, a sound, a gulf and three mountain ranges. Every city has an airport
 * with a full runway (markings, edge and approach lights, PAPI), and coastal or lakeside cities have a
 * seaglider dock. One height function drives both the terrain mesh and the flight model's ground
 * contact, so what you see is what you hit. Distances are compressed: the continent is ~140 x 95 km.
 */

const D2R = Math.PI / 180;
export const BOUNDS = { x0: -90000, x1: 90000, z0: -60000, z1: 60000 };
const SEA = 0;
const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const gauss = (d, w) => Math.exp(-(d * d) / (w * w));

/* ----------------------------------- cities ----------------------------------- */

/**
 * Cities. Positions in metres (x east, z south). `rwy`: airport offset from the city, runway compass
 * heading (degrees) and length. `dock`: seaglider spawn on the water (compass heading). `maxH`: tallest
 * buildings; `count`: building budget; `spread`: city radius.
 */
export const CITIES = [
  { name: 'Seattle', code: 'SEA', x: -60500, z: -38000, elev: 60, maxH: 280, count: 900, spread: 3800, landmark: 'needle',
    rwy: { dx: 2500, dz: 8000, compass: 160, length: 3000 }, dock: { x: -64800, z: -40000, compass: 0 } },
  { name: 'San Francisco', code: 'SFO', x: -66000, z: -5000, elev: 40, maxH: 300, count: 1100, spread: 3200, landmark: 'bridge',
    rwy: { dx: 1500, dz: 11000, compass: 100, length: 3000 }, dock: { x: -60500, z: -3000, compass: 0 } },
  { name: 'Los Angeles', code: 'LAX', x: -65500, z: 28000, elev: 60, maxH: 250, count: 2200, spread: 6000, landmark: 'sign',
    rwy: { dx: 6500, dz: 6000, compass: 70, length: 3300 }, dock: { x: -74000, z: 30000, compass: 340 } },
  { name: 'Denver', code: 'DEN', x: -16000, z: -6000, elev: 1600, maxH: 220, count: 800, spread: 3500,
    rwy: { dx: 8500, dz: 2000, compass: 170, length: 3600 }, dock: null },
  { name: 'Dallas', code: 'DFW', x: 10000, z: 24000, elev: 180, maxH: 280, count: 1200, spread: 4500, landmark: 'ball',
    rwy: { dx: -7000, dz: -3000, compass: 180, length: 3500 }, dock: null },
  { name: 'Chicago', code: 'ORD', x: 17000, z: -26000, elev: 15, maxH: 440, count: 1500, spread: 4500, landmark: 'supertall',
    rwy: { dx: -8500, dz: 1000, compass: 90, length: 3300 }, dock: { x: 21500, z: -30500, compass: 30 } },
  { name: 'New York', code: 'JFK', x: 63000, z: -17000, elev: 10, maxH: 430, count: 2600, spread: 4200, landmark: 'spires',
    rwy: { dx: 3500, dz: 10000, compass: 40, length: 3400 }, dock: { x: 69500, z: -14000, compass: 90 } },
  { name: 'Miami', code: 'MIA', x: 66000, z: 36500, elev: 5, maxH: 260, count: 1000, spread: 3200, landmark: 'beach',
    rwy: { dx: -8500, dz: -1500, compass: 90, length: 3200 }, dock: { x: 71500, z: 37500, compass: 0 } },
];

const compassToHeading = (c) => (90 - c) * D2R; // scene heading: 0 = +X (east), positive towards north (-Z)
const runwayNumber = (c) => String(Math.round(((c % 360) + 360) % 360 / 10) || 36).padStart(2, '0');

export const AIRPORTS = CITIES.map((c) => ({
  name: `${c.name} (${c.code})`,
  city: c,
  x: c.x + c.rwy.dx,
  z: c.z + c.rwy.dz,
  elev: c.elev,
  runway: {
    heading: compassToHeading(c.rwy.compass),
    length: c.rwy.length,
    width: 45,
    numbers: [runwayNumber(c.rwy.compass), runwayNumber(c.rwy.compass + 180)],
  },
}));

function runwayFrame(ap) {
  const h = ap.runway.heading;
  return { dir: new THREE.Vector2(Math.cos(h), -Math.sin(h)), left: new THREE.Vector2(-Math.sin(h), -Math.cos(h)) };
}

function runwayLocal(ap, x, z) {
  const { dir, left } = runwayFrame(ap);
  const dx = x - ap.x;
  const dz = z - ap.z;
  return { along: dx * dir.x + dz * dir.y, left: dx * left.x + dz * left.y };
}

function runwayPoint(ap, along, left = 0) {
  const { dir, left: l } = runwayFrame(ap);
  return new THREE.Vector2(ap.x + dir.x * along + l.x * left, ap.z + dir.y * along + l.y * left);
}

/** Both landing directions of every runway, with threshold, touchdown and approach-gate points. */
export function runwayEnds() {
  const ends = [];
  for (const ap of AIRPORTS) {
    const R = ap.runway;
    for (const [sign, num] of [[1, R.numbers[0]], [-1, R.numbers[1]]]) {
      const thresholdAlong = -sign * (R.length / 2 - 60);
      const heading = R.heading + (sign > 0 ? 0 : Math.PI);
      const threshold = runwayPoint(ap, thresholdAlong);
      const touchdown = runwayPoint(ap, thresholdAlong + sign * 300);
      const gateDist = 9000;
      const gate = runwayPoint(ap, thresholdAlong - sign * gateDist);
      ends.push({
        airport: ap,
        name: `${ap.city.name} RWY ${num}`,
        number: num,
        heading,
        threshold,
        touchdown,
        gate: new THREE.Vector3(gate.x, ap.elev + Math.tan(3 * D2R) * (gateDist + 300), gate.y),
        sign,
      });
    }
  }
  return ends;
}

/* ----------------------------------- terrain ----------------------------------- */

/** Signed distance-like value from the coast: positive on land, negative at sea. */
function coastDistance(x, z) {
  const n = (fbm(x * 0.00004 + 11, z * 0.00004 - 5, 4) - 0.5) * 9000;
  const west = x - (-70000 + n);
  const east = 71000 + n - x;
  const north = z - (-47000 + n * 0.8);
  const south = 46000 + n * 0.8 - z;
  // Gulf coast: the south shore between the west coast and the Florida-like peninsula is further north
  const gulf = x > -38000 && x < 50000 ? 36500 + n * 0.6 + 4000 * Math.sin(x * 0.00012) - z + sstep(40000, 50000, x) * 12000 : 1e9;
  return Math.min(west, east, north, south, gulf);
}

/** Inland and coastal water bodies carved below sea level: [cx, cz, rx, rz]. */
const BASINS = [
  [24000, -37000, 9000, 12000], // Great Lake beside Chicago
  [-61500, -2500, 2600, 6500], // San Francisco Bay
  [-64600, -41000, 1300, 9000], // Puget Sound
  [68500, -13500, 2600, 2200], // New York harbour
];
/** Channels: [x0, z0, x1, z1, halfWidth]. */
const CHANNELS = [
  [-72000, -10500, -61000, -10500, 900], // the Golden Gate strait, linking the bay to the ocean
  [-64600, -50000, -64600, -32000, 1000], // Puget Sound to the open sea
  [68500, -13500, 76000, -13000, 1100], // New York harbour mouth
];

function channelDepth(x, z) {
  let d = 0;
  for (const [cx, cz, rx, rz] of BASINS) {
    const r = Math.hypot((x - cx) / rx, (z - cz) / rz);
    d = Math.max(d, 1 - sstep(0.75, 1.05, r));
  }
  for (const [x0, z0, x1, z1, hw] of CHANNELS) {
    const vx = x1 - x0;
    const vz = z1 - z0;
    const t = Math.max(0, Math.min(1, ((x - x0) * vx + (z - z0) * vz) / (vx * vx + vz * vz)));
    const dist = Math.hypot(x - (x0 + vx * t), z - (z0 + vz * t));
    d = Math.max(d, 1 - sstep(hw * 0.7, hw * 1.2, dist));
  }
  return d;
}

function naturalHeight(x, z) {
  const coast = coastDistance(x, z);
  if (coast < -1500) return Math.max(-60, coast * 0.01 - 20);
  const n = fbm(x * 0.00011 + 3.1, z * 0.00011 - 7.3, 6);
  let h = 30 + 250 * sstep(0, 25000, coast) + (n - 0.45) * 380;
  // mountain ranges: the Rockies, the Cascades / Sierra near the west coast, and low eastern hills
  const ridge = fbm(x * 0.00025, z * 0.00025, 5);
  h += gauss(x + 31000, 10000) * (900 + 2600 * ridge) * (1 - sstep(30000, 48000, Math.abs(z)));
  h += gauss(x + 51000, 4500) * (600 + 1700 * ridge) * (1 - sstep(10000, 45000, z));
  h += gauss(x - 45000, 6000) * (200 + 700 * ridge) * (1 - sstep(20000, 40000, z));
  // the Denver plateau rises towards the Rockies
  h += gauss(x + 16000, 14000) * 1100 * (1 - sstep(10000, 30000, Math.abs(z + 6000)));
  // beaches: the land eases down to the waterline
  h = h * sstep(-1500, 1800, coast) + (coast < 0 ? coast * 0.01 - 20 : 0) * (1 - sstep(-1500, 0, coast));
  h -= channelDepth(x, z) * (Math.max(h, 0) + 25);
  return h;
}

/** Ground height at (x, z): natural terrain flattened around cities, airports and their approach paths. */
export function groundAt(x, z) {
  let h = naturalHeight(x, z);
  for (const c of CITIES) {
    const d = Math.hypot(x - c.x, z - c.z);
    if (d < c.spread * 1.8 && h > -5) h += (c.elev - h) * (1 - sstep(c.spread * 0.9, c.spread * 1.8, d)) * (h > 2 ? 1 : 0.0);
  }
  for (const ap of AIRPORTS) {
    const { along, left } = runwayLocal(ap, x, z);
    const d = Math.hypot(Math.max(0, Math.abs(along) - ap.runway.length / 2), Math.max(0, Math.abs(left) - 400));
    h += (ap.elev - h) * (1 - sstep(900, 3200, d));
    const out = Math.abs(along) - ap.runway.length / 2;
    if (out > 0 && out < 16000) {
      const cap = ap.elev + Math.tan(2 * D2R) * out;
      const mask = (1 - sstep(900, 2400, Math.abs(left))) * (1 - sstep(14000, 16000, out));
      if (h > cap) h += (cap - h) * mask;
    }
  }
  return h;
}

/** The surface aircraft touch: terrain, or the water surface at sea level. */
export function surfaceHeight(x, z) {
  return Math.max(groundAt(x, z), SEA);
}

export function runwayAt(x, z) {
  for (const ap of AIRPORTS) {
    const { along, left } = runwayLocal(ap, x, z);
    if (Math.abs(along) <= ap.runway.length / 2 + 30 && Math.abs(left) <= ap.runway.width / 2 + 8) return ap;
  }
  return null;
}

/** What is underneath: 'runway', 'grass' (airport infield), 'water', 'city' or 'rough'. */
export function surfaceAt(x, z) {
  if (runwayAt(x, z)) return 'runway';
  const h = groundAt(x, z);
  if (h < SEA + 0.5) return 'water';
  for (const ap of AIRPORTS) {
    const { along, left } = runwayLocal(ap, x, z);
    if (Math.abs(along) < ap.runway.length / 2 + 500 && Math.abs(left) < 700) return 'grass';
  }
  for (const c of CITIES) if (Math.hypot(x - c.x, z - c.z) < c.spread) return 'city';
  return 'rough';
}

function terrainMesh() {
  const W = BOUNDS.x1 - BOUNDS.x0;
  const D = BOUNDS.z1 - BOUNDS.z0;
  const geo = new THREE.PlaneGeometry(W, D, 450, 300);
  geo.rotateX(-Math.PI / 2);
  geo.translate((BOUNDS.x0 + BOUNDS.x1) / 2, 0, (BOUNDS.z0 + BOUNDS.z1) / 2);
  const pos = geo.attributes.position;
  const colors = [];
  const pal = {
    seabed: new THREE.Color('#3b5a63'),
    sand: new THREE.Color('#d6c69b'),
    grass: new THREE.Color('#5f733d'),
    plains: new THREE.Color('#8c8a55'),
    dry: new THREE.Color('#957f58'),
    rock: new THREE.Color('#7b746d'),
    snow: new THREE.Color('#eef1f4'),
  };
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = groundAt(x, z);
    pos.setY(i, h);
    if (h < 0) c.copy(pal.seabed);
    else if (h < 14) c.copy(pal.sand);
    else if (h < 600) c.copy(pal.grass).lerp(pal.plains, sstep(0, 1, (x + 10000) / 60000) * 0.8);
    else if (h < 1700) c.copy(pal.plains).lerp(pal.dry, (h - 600) / 1100);
    else if (h < 2700) c.copy(pal.dry).lerp(pal.rock, (h - 1700) / 1000);
    else c.copy(pal.rock).lerp(pal.snow, Math.min(1, (h - 2700) / 300));
    const v = 0.9 + 0.2 * hash2(Math.round(x / 500), Math.round(z / 500));
    colors.push(c.r * v, c.g * v, c.b * v);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 8 }));
  mesh.receiveShadow = true;
  return mesh;
}

/* ---------------------------------- obstacles ---------------------------------- */

/** Solid boxes (buildings, towers, the bridge) in a 250 m spatial hash, for collision checks. */
const OBST_CELL = 250;
const obstacles = new Map();

function addObstacle(cx, cz, hw, hd, y0, y1, name) {
  const box = { cx, cz, hw, hd, y0, y1, name };
  for (let i = Math.floor((cx - hw) / OBST_CELL); i <= Math.floor((cx + hw) / OBST_CELL); i++) {
    for (let j = Math.floor((cz - hd) / OBST_CELL); j <= Math.floor((cz + hd) / OBST_CELL); j++) {
      const key = `${i},${j}`;
      if (!obstacles.has(key)) obstacles.set(key, []);
      obstacles.get(key).push(box);
    }
  }
}

/** Name of the obstacle containing (x, y, z), or null. */
export function obstacleAt(x, y, z) {
  const list = obstacles.get(`${Math.floor(x / OBST_CELL)},${Math.floor(z / OBST_CELL)}`);
  if (!list) return null;
  for (const b of list) {
    if (Math.abs(x - b.cx) < b.hw && Math.abs(z - b.cz) < b.hd && y > b.y0 && y < b.y1) return b.name;
  }
  return null;
}

/** True inside any airport's runway zone or approach corridor, where nothing may be built. */
function inApproachZone(x, z) {
  for (const ap of AIRPORTS) {
    const { along, left } = runwayLocal(ap, x, z);
    const out = Math.abs(along) - ap.runway.length / 2;
    if (Math.abs(left) < 1300 && out < 16000) return true;
  }
  return false;
}

/* ------------------------------------ cities ------------------------------------ */

/** Façade texture: a light grid of floors and windows; the corner pixel is plain for roofs. */
function facadeTexture(aniso) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 64, 64);
  for (let r = 0; r < 4; r++) {
    for (let k = 0; k < 4; k++) {
      g.fillStyle = (r + k) % 3 === 0 ? '#5d6b78' : '#6f7e8c';
      g.fillRect(3 + k * 16, 4 + r * 16, 11, 9);
    }
  }
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 2, 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  return t;
}

const PALETTES = {
  glass: ['#8fa4b6', '#a7b6c2', '#6f8597', '#c9cfd3', '#9aa9a3', '#b4a99a'],
  warm: ['#d8cbb3', '#c9b79c', '#e6dccb', '#b8a68f', '#d2c4ae', '#9fb0ba'],
  pastel: ['#f1ece1', '#e9dcc8', '#d9e8ea', '#f4e2d4', '#cfe0e6', '#ffffff'],
};

/** All of a city's buildings as one merged mesh (box per building, vertex colours, façade UVs). */
function cityBuildings(city, mats) {
  const pos = [];
  const uv = [];
  const col = [];
  const idx = [];
  let seed = Math.round(Math.abs(city.x + city.z * 3)) % 2147483646 || 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const palette = city.landmark === 'beach' ? PALETTES.pastel : city.landmark === 'sign' || city.code === 'DFW' ? PALETTES.warm : PALETTES.glass;
  const color = new THREE.Color();
  const addBox = (cx, cz, w, d, h, base, rot) => {
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    const corner = (sx, sz) => [cx + sx * cs * w / 2 - sz * sn * d / 2, cz + sx * sn * w / 2 + sz * cs * d / 2];
    const c4 = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    color.set(palette[Math.floor(rnd() * palette.length)]);
    const shade = 0.85 + rnd() * 0.25;
    const pushV = (x, y, z, u, v) => {
      pos.push(x, y, z);
      uv.push(u, v);
      col.push(color.r * shade, color.g * shade, color.b * shade);
    };
    // four walls
    for (let k = 0; k < 4; k++) {
      const [ax, az] = c4[k];
      const [bx, bz] = c4[(k + 1) % 4];
      const len = Math.hypot(bx - ax, bz - az);
      const i0 = pos.length / 3;
      pushV(ax, base, az, 0, 0);
      pushV(bx, base, bz, len / 14, 0);
      pushV(bx, base + h, bz, len / 14, h / 14);
      pushV(ax, base + h, az, 0, h / 14);
      idx.push(i0, i0 + 2, i0 + 1, i0, i0 + 3, i0 + 2);
    }
    const i0 = pos.length / 3;
    for (const [x, z] of c4) pushV(x, base + h, z, 0.005, 0.005);
    idx.push(i0, i0 + 2, i0 + 1, i0, i0 + 3, i0 + 2);
  };
  const block = 85;
  const R = city.spread;
  let placed = 0;
  for (let gx = -R; gx <= R && placed < city.count; gx += block) {
    for (let gz = -R; gz <= R && placed < city.count; gz += block) {
      const r = Math.hypot(gx, gz) / R;
      if (r > 1 || rnd() > 1.15 - r) continue; // density falls off from downtown
      const x = city.x + gx + (rnd() - 0.5) * 20;
      const z = city.z + gz + (rnd() - 0.5) * 20;
      const ground = groundAt(x, z);
      if (ground < 2 || surfaceAt(x, z) !== 'city' || inApproachZone(x, z)) continue;
      const core = Math.exp(-((r / 0.28) ** 2));
      const h = 8 + (city.maxH - 8) * core * (0.25 + 0.75 * rnd() ** 1.5) + 30 * rnd() * (1 - r);
      const w = 22 + rnd() * 34;
      const d = 22 + rnd() * 34;
      addBox(x, z, w, d, h, ground - 2, 0);
      addObstacle(x, z, w / 2, d / 2, ground - 2, ground - 2 + h, `a building in ${city.name}`);
      placed++;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mats.facade);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

function landmark(city, mats) {
  const g = new THREE.Group();
  const ground = city.elev;
  const label = { needle: 'the observation tower', bridge: 'the bridge', ball: 'the tower', supertall: 'a skyscraper', spires: 'a skyscraper' }[city.landmark] || 'a landmark';
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    geo.computeBoundingBox();
    const b = geo.boundingBox;
    addObstacle(x + (b.min.x + b.max.x) / 2, z + (b.min.z + b.max.z) / 2, (b.max.x - b.min.x) / 2, (b.max.z - b.min.z) / 2, y + b.min.y, y + b.max.y, label);
    return m;
  };
  const near = (dx, dz) => [city.x + dx, city.z + dz];
  switch (city.landmark) {
    case 'needle': {
      // observation tower: three-legged column with a flying-saucer top
      const [x, z] = near(-900, -700);
      add(new THREE.CylinderGeometry(2.5, 9, 150, 12), mats.white, x, ground + 75, z);
      add(new THREE.CylinderGeometry(24, 12, 9, 32), mats.white, x, ground + 155, z);
      add(new THREE.CylinderGeometry(15, 15, 4, 32), mats.glassDark, x, ground + 160, z);
      add(new THREE.CylinderGeometry(0.6, 1.2, 25, 8), mats.white, x, ground + 175, z);
      break;
    }
    case 'bridge': {
      // suspension bridge across the strait, international orange
      const x = -66500;
      const zN = -12200;
      const zS = -8800;
      const deckY = 67;
      add(new THREE.BoxGeometry(27, 4, zS - zN), mats.bridge, x, deckY, (zN + zS) / 2);
      for (const zt of [-11140, -9860]) {
        for (const off of [-11, 11]) add(new THREE.BoxGeometry(6, 227, 7), mats.bridge, x + off, 113, zt);
        add(new THREE.BoxGeometry(28, 8, 6), mats.bridge, x, 215, zt);
        add(new THREE.BoxGeometry(28, 6, 6), mats.bridge, x, 150, zt);
      }
      // main cables as catenary tubes, plus side spans
      for (const off of [-11, 11]) {
        const pts = [];
        for (let i = 0; i <= 40; i++) {
          const t = i / 40;
          const zz = zN + (zS - zN) * t;
          let y;
          if (zz < -11140) y = deckY + 6 + (220 - deckY - 6) * ((zz - zN) / (-11140 - zN));
          else if (zz > -9860) y = 220 - (220 - deckY - 6) * ((zz + 9860) / (zS + 9860));
          else {
            const u = (zz + 11140) / 1280;
            y = deckY + 8 + (220 - deckY - 8) * (2 * u - 1) ** 2;
          }
          pts.push(new THREE.Vector3(x + off, y, zz));
        }
        g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 80, 0.8, 6), mats.bridge));
      }
      break;
    }
    case 'sign': {
      // big white letters on a hillside north of the city
      const [x, z] = near(-1200, -5200);
      const gy = groundAt(x, z);
      const sign = textPlane('HOLLYWOOD', 600, 140, '#ffffff');
      sign.rotation.set(-0.25, 0, 0);
      sign.position.set(x, gy + 70, z);
      g.add(sign);
      break;
    }
    case 'ball': {
      const [x, z] = near(-600, 500);
      add(new THREE.CylinderGeometry(4, 5, 160, 12), mats.concrete, x, ground + 80, z);
      add(new THREE.SphereGeometry(20, 24, 16), mats.lattice, x, ground + 170, z);
      break;
    }
    case 'supertall': {
      // a black stepped supertall with twin antennas, by the lake
      const [x, z] = near(600, -900);
      const steps = [[68, 230], [55, 330], [44, 410], [32, 442]];
      let base = ground;
      for (const [w, top] of steps) {
        add(new THREE.BoxGeometry(w, top - (base - ground), w), mats.glassDark, x, (base + ground + top) / 2, z);
        base = ground + top;
      }
      for (const off of [-8, 8]) add(new THREE.CylinderGeometry(0.8, 1.2, 90, 8), mats.white, x + off, ground + 442 + 45, z);
      break;
    }
    case 'spires': {
      // a supertall with a spire and an art-deco tower among the skyline
      let [x, z] = near(-300, 400);
      add(new THREE.BoxGeometry(62, 417, 62), mats.glassDark, x, ground + 208, z);
      add(new THREE.CylinderGeometry(1, 3, 124, 8), mats.white, x, ground + 417 + 62, z);
      [x, z] = near(900, -600);
      add(new THREE.BoxGeometry(56, 320, 40), mats.concrete, x, ground + 160, z);
      add(new THREE.BoxGeometry(36, 60, 26), mats.concrete, x, ground + 350, z);
      add(new THREE.CylinderGeometry(0.8, 5, 60, 8), mats.white, x, ground + 410, z);
      break;
    }
    default:
      break;
  }
  return g;
}

function dock(city, mats) {
  const d = city.dock;
  const g = new THREE.Group();
  const h = compassToHeading(d.compass);
  const pier = new THREE.Mesh(new THREE.BoxGeometry(180, 3, 14), mats.concrete);
  pier.position.set(d.x - Math.sin(h) * 40 - Math.cos(h) * 120, 1.2, d.z - Math.cos(h) * 40 + Math.sin(h) * 120);
  pier.rotation.y = h;
  pier.receiveShadow = true;
  g.add(pier);
  const shed = new THREE.Mesh(new THREE.BoxGeometry(40, 9, 20), mats.terminal);
  shed.position.copy(pier.position).add(new THREE.Vector3(0, 6, 0));
  shed.rotation.y = h;
  g.add(shed);
  return g;
}

function buildRunway(ap, mats) {
  const R = ap.runway;
  const g = new THREE.Group(); // runway-local: X along the runway, Z to the right
  const flatAt = (w, d, mat, x, z, y) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    m.receiveShadow = true;
    return m;
  };
  g.add(flatAt(R.length + 120, R.width + 16, mats.shoulder, 0, 0, 0.02));
  g.add(flatAt(R.length, R.width, mats.runway, 0, 0, 0.04));
  for (let x = -R.length / 2 + 140; x < R.length / 2 - 140; x += 60) g.add(flatAt(30, 0.9, mats.white, x, 0, 0.06));
  for (const side of [-1, 1]) g.add(flatAt(R.length, 0.9, mats.white, 0, side * (R.width / 2 - 1), 0.06));
  for (const end of [-1, 1]) {
    const xT = end * (R.length / 2 - 15);
    for (let k = 0; k < 12; k++) {
      if (k === 5 || k === 6) continue;
      g.add(flatAt(45, 1.8, mats.white, xT - end * 22, -R.width / 2 + 3 + k * 3.6, 0.06));
    }
    const num = textPlane(end < 0 ? R.numbers[0] : R.numbers[1], 9, 18);
    num.position.set(xT - end * 72, 0.07, 0);
    num.rotation.z = end < 0 ? -Math.PI / 2 : Math.PI / 2;
    g.add(num);
    for (const zz of [-8, 8]) g.add(flatAt(22, 4, mats.white, xT - end * 330, zz, 0.06)); // aiming points
    // approach light bar running out from the threshold
    for (let k = 1; k <= 20; k++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, k % 5 === 0 ? 18 : 6), mats.approachLight);
      bar.position.set(end * (R.length / 2 + 30 * k), 0.5, 0);
      g.add(bar);
    }
  }
  // edge lights
  const edge = new THREE.InstancedMesh(new THREE.SphereGeometry(0.45, 8, 6), mats.edgeLight, Math.ceil(R.length / 60) * 2 + 2);
  const M = new THREE.Matrix4();
  let n = 0;
  for (let x = -R.length / 2; x <= R.length / 2; x += 60) {
    for (const side of [-1, 1]) edge.setMatrixAt(n++, M.makeTranslation(x, 0.35, side * (R.width / 2 + 3)));
  }
  edge.count = n;
  g.add(edge);
  // PAPI: four lights left of each touchdown zone; colours set every frame from the aircraft's angle
  const papis = [];
  for (const end of [-1, 1]) {
    const lights = [];
    for (let k = 0; k < 4; k++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.6, 2.4), mats.papiWhite.clone());
      // the left side of the landing direction: low end lands towards +X, left = -Z
      const zSide = end < 0 ? -1 : 1;
      m.position.set(end * (R.length / 2 - 360), 0.7, zSide * (R.width / 2 + 15 + k * 9));
      g.add(m);
      lights.push(m);
    }
    papis.push({ end, lights });
  }
  g.position.set(ap.x, ap.elev, ap.z);
  g.rotation.y = R.heading;
  return { group: g, papis };
}

function smallField(ap, mats) {
  const g = new THREE.Group();
  const R = ap.runway;
  const z = R.width / 2 + 120;
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(260, 110), mats.concrete);
  apron.rotation.x = -Math.PI / 2;
  apron.position.set(0, 0.03, z);
  apron.receiveShadow = true;
  g.add(apron);
  g.add(box(40, 12, 30, mats.building, -60, 6, z + 75));
  g.add(box(40, 12, 30, mats.building, 0, 6, z + 75));
  const tw = tower(mats);
  tw.position.set(90, 0, z + 60);
  g.add(tw);
  const ws = windsock(mats);
  ws.position.set(-R.length / 2 + 400, 0, -(R.width / 2 + 60));
  g.add(ws);
  g.position.set(ap.x, ap.elev, ap.z);
  g.rotation.y = R.heading;
  return g;
}


function trees(mats) {
  const geo = new THREE.ConeGeometry(3.4, 11, 7);
  geo.translate(0, 7, 0);
  const N = 9000;
  const mesh = new THREE.InstancedMesh(geo, mats.tree, N);
  const M = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let n = 0;
  let guard = 0;
  while (n < N && guard++ < 120000) {
    const c = CITIES[n % CITIES.length];
    const x = c.x + (rnd() - 0.5) * 22000;
    const z = c.z + (rnd() - 0.5) * 22000;
    if (surfaceAt(x, z) !== 'rough') continue;
    const h = groundAt(x, z);
    if (h < 8 || h > 2200 || fbm(x * 0.0015, z * 0.0015, 3) < 0.5) continue;
    const s = 0.7 + rnd() * 0.9;
    M.compose(p.set(x, h, z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.3), sc.set(s, s, s));
    mesh.setMatrixAt(n++, M);
  }
  mesh.count = n;
  return mesh;
}

function clouds() {
  const g = new THREE.Group();
  const tex = glowTex();
  let seed = 5;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 520; i++) {
    const m = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, color: 0xf3f6f9, transparent: true, opacity: 0.4 + rnd() * 0.35, depthWrite: false, toneMapped: false, fog: false }),
    );
    const s = 300 + rnd() * 900;
    m.scale.set(s * 1.9, s * 0.65, 1);
    m.position.set(BOUNDS.x0 + rnd() * (BOUNDS.x1 - BOUNDS.x0), 2200 + rnd() * 1800, BOUNDS.z0 + rnd() * (BOUNDS.z1 - BOUNDS.z0));
    g.add(m);
  }
  return g;
}

/* ----------------------------------- assembly ----------------------------------- */

/** Spawn points: every runway end, and each city's seaglider dock. */
export function spawnPoints() {
  return {
    ends: runwayEnds(),
    docks: CITIES.filter((c) => c.dock).map((c) => ({ city: c, x: c.dock.x, z: c.dock.z, heading: compassToHeading(c.dock.compass), name: `${c.name} waterfront` })),
  };
}

export function buildGameWorld(renderer) {
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const std = (p) => new THREE.MeshStandardMaterial(p);
  const concreteMap = concreteTexture(aniso);
  concreteMap.repeat.set(20, 8);
  const runwayMap = asphaltTex(aniso);
  runwayMap.repeat.set(80, 1.2);
  const grassMap = grassTex(aniso);
  grassMap.repeat.set(180, 180);
  const mats = {
    runway: std({ map: runwayMap, roughness: 0.9 }),
    shoulder: std({ color: 0x5d5e58, roughness: 0.95 }),
    concrete: std({ map: concreteMap, roughness: 0.92 }),
    grass: std({ map: grassMap, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 }),
    white: paintMat(0xeeeeea),
    yellow: paintMat(0xd9a91a),
    edgeLight: std({ color: 0xffffff, emissive: 0xfff2c0, emissiveIntensity: 2.5 }),
    approachLight: std({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 3 }),
    papiWhite: std({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 4 }),
    building: std({ color: 0xc8c1b2, roughness: 0.85 }),
    terminal: std({ color: 0xd9dde0, roughness: 0.6, metalness: 0.2 }),
    towerGlass: std({ color: 0x1e3140, metalness: 0.6, roughness: 0.15 }),
    metal: std({ color: 0x8b8e91, metalness: 0.8, roughness: 0.4 }),
    sock: std({ color: 0xff6a1a, roughness: 0.7, side: THREE.DoubleSide }),
    tree: std({ color: 0x3f5530, roughness: 0.95, flatShading: true }),
    facade: std({ map: facadeTexture(aniso), vertexColors: true, roughness: 0.55, metalness: 0.25 }),
    glassDark: std({ color: 0x22282e, roughness: 0.25, metalness: 0.7 }),
    bridge: std({ color: 0xc0392b, roughness: 0.6 }),
    lattice: std({ color: 0xe8e4da, roughness: 0.4, metalness: 0.3 }),
  };
  mats.white = std({ color: 0xeeeeea, roughness: 0.6 });
  const paint = { white: paintMat(0xeeeeea), yellow: paintMat(0xd9a91a) };

  const group = new THREE.Group();
  group.add(terrainMesh());
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(600000, 600000), std({ color: 0x163a52, roughness: 0.2, metalness: 0.05 }));
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = SEA;
  group.add(sea);

  const papis = [];
  const runwayMats = { ...mats, white: paint.white, yellow: paint.yellow };
  for (const ap of AIRPORTS) {
    const infield = new THREE.Mesh(new THREE.CircleGeometry(2400, 64), mats.grass);
    infield.rotation.x = -Math.PI / 2;
    infield.position.set(ap.x, ap.elev + 0.01, ap.z);
    infield.receiveShadow = true;
    group.add(infield);
    const rw = buildRunway(ap, runwayMats);
    group.add(rw.group);
    for (const p of rw.papis) papis.push({ ap, ...p });
    group.add(smallField(ap, mats));
  }
  for (const c of CITIES) {
    group.add(cityBuildings(c, mats));
    group.add(landmark(c, mats));
    if (c.dock) group.add(dock(c, mats));
  }
  group.add(trees(mats));
  group.add(clouds());

  const red = new THREE.Color(0xff2a1a);
  const white = new THREE.Color(0xffffff);
  const tmp = new THREE.Vector3();
  return {
    group,
    groundAt,
    surfaceHeight,
    surfaceAt,
    runwayAt,
    obstacleAt,
    bounds: BOUNDS,
    cities: CITIES,
    airports: AIRPORTS,
    ends: runwayEnds(),
    spawns: spawnPoints(),
    updatePapi(pos) {
      for (const p of papis) {
        p.lights[0].getWorldPosition(tmp);
        if (Math.abs(pos.x - tmp.x) + Math.abs(pos.z - tmp.z) > 30000) continue;
        const dist = Math.hypot(pos.x - tmp.x, pos.z - tmp.z);
        const angle = Math.atan2(pos.y - tmp.y, dist) / D2R;
        const thresholds = [3.5, 3.17, 2.83, 2.5];
        p.lights.forEach((l, k) => {
          const c = angle > thresholds[k] ? white : red;
          l.material.color.copy(c);
          l.material.emissive.copy(c);
        });
      }
    },
  };
}
