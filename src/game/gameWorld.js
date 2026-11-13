import * as THREE from 'three';
import {
  fbm, hash2, grassTex, asphaltTex, concreteTexture, glowTex, textPlane, paintMat, box,
  shelter, tower, fuelTruck, tug, lightPole, windsock,
} from '../world/world.js';

/*
 * The game world: 80 × 80 km of terrain with a coastline, two airports with full-length runways,
 * PAPI glide-slope lights and approach lights, plus clouds. The same height function drives the
 * terrain mesh and the flight model's ground contact, so what you see is what you hit.
 */

const D2R = Math.PI / 180;
const SIZE = 80000;
const SEA = 0;
const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/* ---------------------------------- airports ---------------------------------- */

/**
 * Runways: centre (x, z), heading of the "low" end's direction of travel (radians from +X towards -Z),
 * length and width in metres, and the two runway numbers.
 */
export const AIRPORTS = [
  {
    name: 'Raptor AFB',
    x: 0,
    z: 0,
    elev: 45,
    runway: { heading: 0, length: 3200, width: 46, numbers: ['09', '27'] },
    base: true,
  },
  {
    name: 'Lakeside Field',
    x: 17000,
    z: -13000,
    elev: 110,
    runway: { heading: 35 * D2R, length: 2800, width: 45, numbers: ['06', '24'] },
  },
];

function runwayFrame(ap) {
  const h = ap.runway.heading;
  return { dir: new THREE.Vector2(Math.cos(h), -Math.sin(h)), left: new THREE.Vector2(-Math.sin(h), -Math.cos(h)) };
}

/** Runway-local coordinates of a point: along the centreline (+ towards the high end) and to the left. */
function runwayLocal(ap, x, z) {
  const { dir, left } = runwayFrame(ap);
  const dx = x - ap.x;
  const dz = z - ap.z;
  return { along: dx * dir.x + dz * dir.y, left: dx * left.x + dz * left.y };
}

/** Point at runway-local (along, left) in world X/Z. */
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
        name: `${ap.name} RWY ${num}`,
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

/* ---------------------------------- terrain ---------------------------------- */

/** Height of the ground (m) at world (x, z). Airports sit on flat plateaus; the sea is to the south-east. */
export function groundAt(x, z) {
  let h = (fbm(x * 0.00009 + 3.1, z * 0.00009 - 7.3, 6) - 0.42) * 2600 + 260;
  h += (fbm(x * 0.0006, z * 0.0006, 3) - 0.5) * 60; // small hills
  h -= sstep(6000, 22000, z * 0.8 + x * 0.25) * 1700; // coast towards +Z
  for (const ap of AIRPORTS) {
    const { along, left } = runwayLocal(ap, x, z);
    const d = Math.hypot(Math.max(0, Math.abs(along) - ap.runway.length / 2), Math.max(0, Math.abs(left) - 400));
    h += (ap.elev - h) * (1 - sstep(900, 3200, d));
    // keep both approach corridors below a 2° slope out to 14 km, so no hill sits under the glide path
    const out = Math.abs(along) - ap.runway.length / 2;
    if (out > 0 && out < 16000) {
      const cap = ap.elev + Math.tan(2 * D2R) * out;
      const mask = (1 - sstep(900, 2400, Math.abs(left))) * (1 - sstep(14000, 16000, out));
      if (h > cap) h += (cap - h) * mask;
    }
  }
  return h;
}

export function runwayAt(x, z) {
  for (const ap of AIRPORTS) {
    const { along, left } = runwayLocal(ap, x, z);
    if (Math.abs(along) <= ap.runway.length / 2 + 30 && Math.abs(left) <= ap.runway.width / 2 + 8) return ap;
  }
  return null;
}

/** What the wheels are on: 'runway', 'grass' (airport infield), 'water' or 'rough'. */
export function surfaceAt(x, z) {
  if (runwayAt(x, z)) return 'runway';
  const h = groundAt(x, z);
  if (h < SEA + 0.5) return 'water';
  for (const ap of AIRPORTS) {
    const { along, left } = runwayLocal(ap, x, z);
    if (Math.abs(along) < ap.runway.length / 2 + 500 && Math.abs(left) < 700) return 'grass';
  }
  return 'rough';
}

function terrainMesh() {
  const seg = 340;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = [];
  const sand = new THREE.Color('#cdbd94');
  const grass = new THREE.Color('#5d6e3c');
  const dry = new THREE.Color('#8b7c57');
  const rock = new THREE.Color('#7a736c');
  const snow = new THREE.Color('#eceff2');
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = groundAt(x, z);
    pos.setY(i, h);
    if (h < 12) c.copy(sand);
    else if (h < 500) c.copy(grass).lerp(dry, (h - 12) / 488);
    else if (h < 1400) c.copy(dry).lerp(rock, (h - 500) / 900);
    else c.copy(rock).lerp(snow, Math.min(1, (h - 1400) / 300));
    const v = 0.9 + 0.2 * hash2(Math.round(x / 400), Math.round(z / 400));
    colors.push(c.r * v, c.g * v, c.b * v);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  // pushed back in depth so airport surfaces drawn at the same height always win
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 8 }));
  mesh.receiveShadow = true;
  return mesh;
}

/* ---------------------------------- airports ---------------------------------- */

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

function buildBase(ap, mats, jetTemplate) {
  const g = new THREE.Group();
  const R = ap.runway;
  // apron and taxiway on the north side (runway-local -Z), connected to the runway
  const apronZ = -(R.width / 2 + 260);
  const plane = (w, d, mat, x, z, y) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    m.receiveShadow = true;
    return m;
  };
  g.add(plane(420, 160, mats.concrete, -300, apronZ, 0.03));
  for (const x of [-700, 100]) g.add(plane(23, 260 - R.width / 2, mats.taxi, x, apronZ / 2 - 30, 0.025));
  g.add(plane(0.3, 260 - R.width / 2, mats.yellow, -700, apronZ / 2 - 30, 0.05));
  for (let k = 0; k < 4; k++) {
    const s = shelter(mats);
    s.position.set(-470 + k * 38, 0, apronZ - 110);
    g.add(s);
  }
  if (jetTemplate) {
    for (const x of [-420, -380, -340]) {
      const c = jetTemplate.clone(true);
      c.position.set(x, 0, apronZ - 30);
      c.rotation.y = -Math.PI / 2; // nose towards the runway
      c.traverse((o) => {
        if (o.isLight) o.visible = false;
      });
      g.add(c);
    }
  }
  const tw = tower(mats);
  tw.position.set(-80, 0, apronZ - 60);
  g.add(tw);
  const ft = fuelTruck(mats);
  ft.position.set(-250, 0, apronZ + 10);
  g.add(ft);
  const tg = tug(mats);
  tg.position.set(-200, 0, apronZ - 10);
  g.add(tg);
  for (const x of [-480, -300, -120]) {
    const lp = lightPole(mats);
    lp.position.set(x, 0, apronZ + 70);
    g.add(lp);
  }
  const ws = windsock(mats);
  ws.position.set(R.length / 2 - 500, 0, R.width / 2 + 60);
  g.add(ws);
  g.position.set(ap.x, ap.elev, ap.z);
  g.rotation.y = R.heading;
  return g;
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
  const N = 4000;
  const mesh = new THREE.InstancedMesh(geo, mats.tree, N);
  const M = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let n = 0;
  let guard = 0;
  while (n < N && guard++ < 60000) {
    const ap = AIRPORTS[n % AIRPORTS.length];
    const x = ap.x + (rnd() - 0.5) * 9000;
    const z = ap.z + (rnd() - 0.5) * 9000;
    if (surfaceAt(x, z) !== 'rough' && surfaceAt(x, z) !== 'grass') continue;
    const { along, left } = runwayLocal(ap, x, z);
    if (Math.abs(along) < ap.runway.length / 2 + 900 && Math.abs(left) < 600) continue;
    const h = groundAt(x, z);
    if (h > 900 || fbm(x * 0.002, z * 0.002, 3) < 0.47) continue;
    const s = 0.7 + rnd() * 0.9;
    M.compose(p.set(x, h, z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.3), sc.set(s, s, s));
    mesh.setMatrixAt(n++, M);
  }
  mesh.count = n;
  mesh.castShadow = false;
  return mesh;
}

function clouds() {
  const g = new THREE.Group();
  const tex = glowTex();
  let seed = 5;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 260; i++) {
    const m = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, color: 0xf3f6f9, transparent: true, opacity: 0.4 + rnd() * 0.35, depthWrite: false, toneMapped: false, fog: false }),
    );
    const s = 300 + rnd() * 900;
    m.scale.set(s * 1.9, s * 0.65, 1);
    m.position.set((rnd() - 0.5) * SIZE * 0.9, 1800 + rnd() * 1600, (rnd() - 0.5) * SIZE * 0.9);
    g.add(m);
  }
  return g;
}

/* ---------------------------------- assembly ---------------------------------- */

export function buildGameWorld(renderer, jetTemplate) {
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const std = (p) => new THREE.MeshStandardMaterial(p);
  const concreteMap = concreteTexture(aniso);
  concreteMap.repeat.set(20, 8);
  const runwayMap = asphaltTex(aniso);
  runwayMap.repeat.set(80, 1.2);
  const taxiMap = asphaltTex(aniso);
  taxiMap.repeat.set(1, 12);
  const grassMap = grassTex(aniso);
  grassMap.repeat.set(180, 180);
  const mats = {
    runway: std({ map: runwayMap, roughness: 0.9 }),
    shoulder: std({ color: 0x5d5e58, roughness: 0.95 }),
    taxi: std({ map: taxiMap, roughness: 0.9 }),
    concrete: std({ map: concreteMap, roughness: 0.92 }),
    grass: std({ map: grassMap, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 }),
    white: paintMat(0xeeeeea),
    yellow: paintMat(0xd9a91a),
    edgeLight: std({ color: 0xffffff, emissive: 0xfff2c0, emissiveIntensity: 2.5 }),
    approachLight: std({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 3 }),
    papiWhite: std({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 4 }),
    shelter: std({ color: 0xa9a59a, roughness: 0.95 }),
    shelterDark: std({ color: 0x1d1d1d, roughness: 1 }),
    shelterFloor: std({ color: 0x77736c, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2 }),
    concreteBlock: std({ color: 0x9d998f, roughness: 0.95 }),
    building: std({ color: 0xc8c1b2, roughness: 0.85 }),
    towerGlass: std({ color: 0x1e3140, metalness: 0.6, roughness: 0.15 }),
    metal: std({ color: 0x8b8e91, metalness: 0.8, roughness: 0.4 }),
    metalDark: std({ color: 0x2f3134, metalness: 0.4, roughness: 0.6 }),
    truck: std({ color: 0xd8d6cc, metalness: 0.3, roughness: 0.5 }),
    truckCab: std({ color: 0x4f5b3a, roughness: 0.6 }),
    tugBody: std({ color: 0xc9a227, roughness: 0.6 }),
    tire: std({ color: 0x1a1a1a, roughness: 0.95 }),
    sock: std({ color: 0xff6a1a, roughness: 0.7, side: THREE.DoubleSide }),
    tree: std({ color: 0x3f5530, roughness: 0.95, flatShading: true }),
  };

  const group = new THREE.Group();
  group.add(terrainMesh());
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(SIZE * 3, SIZE * 3), std({ color: 0x0f2a3b, roughness: 0.22 }));
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = SEA;
  group.add(sea);

  const papis = [];
  for (const ap of AIRPORTS) {
    const infield = new THREE.Mesh(new THREE.CircleGeometry(2600, 64), mats.grass);
    infield.rotation.x = -Math.PI / 2;
    infield.position.set(ap.x, ap.elev + 0.01, ap.z);
    infield.receiveShadow = true;
    group.add(infield);
    const rw = buildRunway(ap, mats);
    group.add(rw.group);
    for (const p of rw.papis) papis.push({ ap, ...p });
    group.add(ap.base ? buildBase(ap, mats, jetTemplate) : smallField(ap, mats));
  }
  group.add(trees(mats));
  group.add(clouds());

  const red = new THREE.Color(0xff2a1a);
  const white = new THREE.Color(0xffffff);
  const tmp = new THREE.Vector3();
  return {
    group,
    groundAt,
    surfaceAt,
    runwayAt,
    ends: runwayEnds(),
    /** Recolour the PAPI lights for an aircraft at `pos` (each light: white above its angle, red below). */
    updatePapi(pos) {
      for (const p of papis) {
        p.lights[0].getWorldPosition(tmp);
        const dist = Math.hypot(pos.x - tmp.x, pos.z - tmp.z);
        const angle = Math.atan2(pos.y - tmp.y, dist) / D2R;
        const thresholds = [3.5, 3.17, 2.83, 2.5]; // outermost light first
        p.lights.forEach((l, k) => {
          const c = angle > thresholds[k] ? white : red;
          l.material.color.copy(c);
          l.material.emissive.copy(c);
        });
      }
    },
  };
}
