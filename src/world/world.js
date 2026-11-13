import * as THREE from 'three';

/*
 * The world around the jet.
 *  - Air base (parked scene): concrete apron, runway with markings and edge lights, taxiway, hardened
 *    aircraft shelters, control tower, ground equipment, more parked Raptors, grass, trees, distant hills.
 *  - Flight scene: tileable procedural terrain and coastline over the sea, plus clouds. Terrain and clouds
 *    scroll past the jet at its airspeed, so the model can stay at the origin.
 */

/* ------------------------------- noise ------------------------------- */

export function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export function vnoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x, y, oct = 5) {
  let s = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < oct; i++) {
    s += amp * vnoise(x * f, y * f);
    f *= 2.03;
    amp *= 0.5;
  }
  return s;
}

/** Noise that repeats every `period` units in x (sampled on a cylinder), for seamless scrolling. */
function fbmPeriodicX(x, z, period, scale, oct = 6) {
  const a = (x / period) * Math.PI * 2;
  const r = (period / (Math.PI * 2)) * scale;
  let s = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < oct; i++) {
    const cx = Math.cos(a) * r * f;
    const cy = Math.sin(a) * r * f;
    s += amp * (vnoise(cx + z * scale * f, cy) * 0.5 + vnoise(cy - z * scale * f * 0.7, cx + 17.3) * 0.5);
    f *= 2.0;
    amp *= 0.5;
  }
  return s;
}

/* ------------------------------ textures ------------------------------ */

export function canvasTex(N, draw, repeat, aniso) {
  const c = document.createElement('canvas');
  c.width = c.height = N;
  draw(c.getContext('2d'), N);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  if (repeat) t.repeat.set(repeat[0], repeat[1]);
  return t;
}

export function speckle(ctx, N, n, colors, size, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < n; k++) {
    ctx.fillStyle = colors[Math.floor(rnd() * colors.length)];
    const w = size[0] + rnd() * (size[1] - size[0]);
    ctx.fillRect(rnd() * N, rnd() * N, w, w);
  }
  return rnd;
}

export const grassTex = (aniso) =>
  canvasTex(1024, (ctx, N) => {
    ctx.fillStyle = '#6f7d48';
    ctx.fillRect(0, 0, N, N);
    const rnd = speckle(ctx, N, 60000, ['rgba(92,110,58,0.5)', 'rgba(130,140,80,0.45)', 'rgba(70,84,44,0.5)', 'rgba(150,140,95,0.35)'], [1, 3], 11);
    for (let k = 0; k < 40; k++) {
      const x = rnd() * N;
      const y = rnd() * N;
      const r = 40 + rnd() * 140;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const v = rnd() < 0.5 ? '160,150,95' : '60,80,40';
      g.addColorStop(0, `rgba(${v},0.25)`);
      g.addColorStop(1, `rgba(${v},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
  }, null, aniso);

export const asphaltTex = (aniso) =>
  canvasTex(1024, (ctx, N) => {
    ctx.fillStyle = '#3d3e40';
    ctx.fillRect(0, 0, N, N);
    speckle(ctx, N, 90000, ['rgba(20,20,22,0.5)', 'rgba(95,95,98,0.45)', 'rgba(60,60,62,0.5)'], [1, 2.5], 29);
  }, null, aniso);

/** Apron concrete: 5 m slabs with joints, tie-down rings, tyre marks and stains. */
export function concreteTexture(aniso) {
  return canvasTex(2048, (ctx, N) => {
    ctx.fillStyle = '#8e8c87';
    ctx.fillRect(0, 0, N, N);
    const rnd = speckle(ctx, N, 70000, ['rgba(255,255,255,0.07)', 'rgba(40,40,38,0.08)', 'rgba(120,118,112,0.12)'], [1, 3], 47);
    const slab = N / 4;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        ctx.fillStyle = `rgba(${rnd() < 0.5 ? '255,255,255' : '0,0,0'},${0.015 + rnd() * 0.02})`;
        ctx.fillRect(i * slab, j * slab, slab, slab);
      }
    }
    for (let k = 0; k < 50; k++) {
      const x = rnd() * N;
      const y = rnd() * N;
      const r = 15 + rnd() * 60;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(45,42,38,${0.08 + rnd() * 0.1})`);
      g.addColorStop(1, 'rgba(45,42,38,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    ctx.lineCap = 'round';
    for (let k = 0; k < 10; k++) {
      ctx.strokeStyle = `rgba(28,28,28,${0.04 + rnd() * 0.06})`;
      ctx.lineWidth = 5 + rnd() * 8;
      ctx.beginPath();
      const y0 = rnd() * N;
      ctx.moveTo(0, y0);
      ctx.quadraticCurveTo(N / 2, y0 + (rnd() - 0.5) * 400, N, y0 + (rnd() - 0.5) * 300);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(38,38,36,0.8)';
    for (let i = 0; i <= 4; i++) {
      ctx.fillRect(i * slab - 2, 0, 4, N);
      ctx.fillRect(0, i * slab - 2, N, 4);
    }
    ctx.strokeStyle = 'rgba(70,70,68,0.85)';
    ctx.lineWidth = 3;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        ctx.beginPath();
        ctx.arc((i + 0.5) * slab, (j + 0.5) * slab, 8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }, null, aniso);
}

export function glowTex() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export function textPlane(str, w, h, color = '#f2f2ee') {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 384;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.font = '700 300px "Arial Narrow", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(str, 128, 200);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
  );
  m.rotation.x = -Math.PI / 2;
  m.receiveShadow = true;
  return m;
}

export const paintMat = (color) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });

export function flat(w, d, mat, x, z, y = 0, rot = 0) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
  m.rotation.x = -Math.PI / 2;
  m.rotation.z = rot;
  m.position.set(x, y, z);
  m.receiveShadow = true;
  return m;
}

export function box(w, h, d, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

/** Hardened aircraft shelter: a concrete arch with an open, door-framed front facing -z. */
export function shelter(mats) {
  const g = new THREE.Group();
  const W = 24;
  const H = 9.5;
  const L = 36;
  // thick concrete arch: half-ellipse ring extruded along the shelter's length
  const T = 1.1;
  const sh = new THREE.Shape();
  sh.absellipse(0, 0, W / 2 + T, H + T, 0, Math.PI, false);
  sh.lineTo(-W / 2, 0);
  sh.absellipse(0, 0, W / 2, H, Math.PI, 0, true);
  sh.lineTo(W / 2 + T, 0);
  const arch = new THREE.ExtrudeGeometry(sh, { depth: L, bevelEnabled: false, curveSegments: 40 });
  arch.translate(0, 0, -L / 2);
  const shell = new THREE.Mesh(arch, mats.shelter);
  shell.castShadow = shell.receiveShadow = true;
  g.add(shell);
  // back wall and dark interior
  const back = new THREE.Mesh(new THREE.CircleGeometry(W / 2, 40, 0, Math.PI), mats.shelterDark);
  back.scale.set(1, H / (W / 2), 1);
  back.position.z = L / 2 - 0.2;
  back.rotation.y = Math.PI;
  g.add(back);
  // blast-door frame at the opening
  for (const x of [-W / 2 - 0.6, W / 2 + 0.6]) g.add(box(1.4, H * 0.9, 2, mats.concreteBlock, x, H * 0.45, -L / 2));
  g.add(box(W + 3, 1.6, 2, mats.concreteBlock, 0, H * 0.94, -L / 2));
  g.add(flat(W, L, mats.shelterFloor, 0, 0, 0.02));
  return g;
}

export function tower(mats) {
  const g = new THREE.Group();
  g.add(box(7, 22, 7, mats.building, 0, 11, 0));
  const cab = new THREE.Mesh(new THREE.CylinderGeometry(6.2, 5.2, 4.2, 8), mats.towerGlass);
  cab.position.y = 24.1;
  g.add(cab);
  g.add(box(13, 0.8, 13, mats.building, 0, 26.6, 0));
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 6, 8), mats.metal);
  ant.position.y = 30;
  g.add(ant);
  g.add(box(26, 7, 14, mats.building, 12, 3.5, 8));
  return g;
}

export function fuelTruck(mats) {
  const g = new THREE.Group();
  g.add(box(2.6, 2.6, 2.5, mats.truckCab, 4.2, 1.7, 0));
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 7, 24), mats.truck);
  tank.rotation.z = Math.PI / 2;
  tank.position.set(-0.6, 1.9, 0);
  tank.castShadow = true;
  g.add(tank);
  g.add(box(10.4, 0.5, 2.4, mats.metalDark, 0.4, 0.75, 0));
  for (const x of [-3.2, -1.6, 4.4]) {
    for (const z of [-1.15, 1.15]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.4, 16), mats.tire);
      w.rotation.x = Math.PI / 2;
      w.position.set(x, 0.5, z);
      g.add(w);
    }
  }
  return g;
}

export function tug(mats) {
  const g = new THREE.Group();
  g.add(box(3.4, 1.1, 2.2, mats.tugBody, 0, 0.85, 0));
  g.add(box(1.2, 1.0, 1.6, mats.metalDark, -0.6, 1.9, 0));
  for (const x of [-1.1, 1.1]) {
    for (const z of [-1.0, 1.0]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.35, 14), mats.tire);
      w.rotation.x = Math.PI / 2;
      w.position.set(x, 0.42, z);
      g.add(w);
    }
  }
  return g;
}

export function lightPole(mats) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.28, 22, 10), mats.metal);
  pole.position.y = 11;
  pole.castShadow = true;
  g.add(pole);
  g.add(box(3.2, 0.8, 0.8, mats.metalDark, 0, 22.2, 0));
  return g;
}

export function windsock(mats) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 7, 8), mats.metal);
  pole.position.y = 3.5;
  g.add(pole);
  const sock = new THREE.Mesh(new THREE.ConeGeometry(0.5, 3.2, 16, 1, true), mats.sock);
  sock.rotation.z = Math.PI / 2 + 0.25;
  sock.position.set(1.7, 6.7, 0);
  g.add(sock);
  return g;
}

/** Ring of low hills/mountains on the horizon (vertex coloured). */
function horizonHills(r0, r1, hMax, seed, mats) {
  const segA = 320;
  const segR = 10;
  const pos = [];
  const col = [];
  const idx = [];
  const cLow = new THREE.Color('#6d7547');
  const cMid = new THREE.Color('#7f7158');
  const cHigh = new THREE.Color('#9c968c');
  const c = new THREE.Color();
  for (let j = 0; j <= segR; j++) {
    const fr = j / segR;
    const r = r0 + (r1 - r0) * fr;
    for (let i = 0; i <= segA; i++) {
      const a = (i / segA) * Math.PI * 2;
      const prof = Math.sin(Math.PI * Math.min(1, fr * 1.4)) * (fr < 0.7 ? 1 : 1 - (fr - 0.7) / 0.3 * 0.6);
      const n = fbmPeriodicX(i * 40, j * 30 + seed, segA * 40, 0.004, 5);
      const h = Math.max(0, (n - 0.32) * 2.2) * hMax * prof;
      pos.push(Math.cos(a) * r, h - 1, Math.sin(a) * r);
      const t = h / hMax;
      c.copy(cLow).lerp(cMid, Math.min(1, t * 2)).lerp(cHigh, Math.max(0, t * 2 - 1));
      col.push(c.r, c.g, c.b);
    }
  }
  for (let j = 0; j < segR; j++) {
    for (let i = 0; i < segA; i++) {
      const a = j * (segA + 1) + i;
      const b = a + segA + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(g, mats.hills);
}

/* ------------------------------- air base ------------------------------- */

/**
 * The jet parks at the origin, nose towards +X. The runway runs along X, 230 m to the -Z side,
 * joined to the apron by a taxiway.
 */
export function buildAirbase(renderer, jet) {
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const std = (p) => new THREE.MeshStandardMaterial(p);
  const concreteMap = concreteTexture(aniso);
  concreteMap.repeat.set(160 / 20, 120 / 20);
  const grass = grassTex(aniso);
  grass.repeat.set(400, 400);
  const asphaltA = asphaltTex(aniso);
  asphaltA.repeat.set(3200 / 40, 1);
  const asphaltB = asphaltTex(aniso);
  asphaltB.repeat.set(1, 200 / 20);
  const mats = {
    grass: std({ map: grass, roughness: 0.95 }),
    concrete: std({ map: concreteMap, roughness: 0.92 }),
    runway: std({ map: asphaltA, roughness: 0.9 }),
    taxi: std({ map: asphaltB, roughness: 0.9 }),
    white: paintMat(0xeeeeea),
    yellow: paintMat(0xd9a91a),
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
    hills: std({ vertexColors: true, roughness: 1, flatShading: true }),
    tree: std({ color: 0x3f5530, roughness: 0.95, flatShading: true }),
    trunk: std({ color: 0x4a3a2a, roughness: 1 }),
    edgeLight: std({ color: 0xffffff, emissive: 0xfff2c0, emissiveIntensity: 2.5 }),
    chock: std({ color: 0xc9c02a, roughness: 0.7 }),
    shadowBlob: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false, map: glowTex() }),
  };

  const g = new THREE.Group();
  g.name = 'airbase';

  // ground: grass to the horizon, concrete apron around the jet
  const grassPlane = flat(16000, 16000, mats.grass, 0, 0, -0.03);
  g.add(grassPlane);
  g.add(flat(160, 120, mats.concrete, -20, 20, 0));

  // runway 06/24-style: 3200 x 46 m with threshold bars, numbers, centreline and edge lights
  const RZ = -230;
  const RL = 3200;
  const RW = 46;
  g.add(flat(RL, RW, mats.runway, 0, RZ, 0.005));
  g.add(flat(RL + 60, RW + 14, mats.taxi, 0, RZ, 0.0));
  for (let x = -RL / 2 + 120; x < RL / 2 - 120; x += 60) g.add(flat(30, 0.9, mats.white, x, RZ, 0.02));
  for (const side of [-1, 1]) g.add(flat(RL, 0.9, mats.white, 0, RZ + side * (RW / 2 - 1), 0.02));
  for (const end of [-1, 1]) {
    const xT = end * (RL / 2 - 15);
    for (let k = 0; k < 12; k++) {
      if (k === 5 || k === 6) continue;
      g.add(flat(45, 1.8, mats.white, xT - end * 22, RZ - RW / 2 + 3 + k * 3.6, 0.02));
    }
    const num = textPlane(end < 0 ? '09' : '27', 9, 18);
    num.position.set(xT - end * 70, 0.025, RZ);
    num.rotation.z = end < 0 ? -Math.PI / 2 : Math.PI / 2;
    g.add(num);
    // touchdown zone markings
    for (const zz of [-8, 8]) g.add(flat(22, 4, mats.white, xT - end * 165, RZ + zz, 0.02));
  }
  const lightGeo = new THREE.SphereGeometry(0.22, 8, 6);
  const nLights = Math.floor(RL / 60) * 2;
  const lights = new THREE.InstancedMesh(lightGeo, mats.edgeLight, nLights);
  const M = new THREE.Matrix4();
  let li = 0;
  for (let x = -RL / 2; x < RL / 2 && li < nLights - 1; x += 60) {
    for (const side of [-1, 1]) lights.setMatrixAt(li++, M.makeTranslation(x, 0.3, RZ + side * (RW / 2 + 3)));
  }
  lights.count = li;
  g.add(lights);

  // taxiway from the apron to the runway with a yellow centreline and the jet's lead-in line
  g.add(flat(23, -RZ - 60, mats.taxi, 80, (RZ + 60) / 2 - 20, 0.004));
  g.add(flat(0.3, -RZ - 60, mats.yellow, 80, (RZ + 60) / 2 - 20, 0.02));
  g.add(flat(90, 0.16, mats.yellow, 5.4 + 45, 0, 0.02));
  g.add(flat(0.3, 2.4, mats.yellow, 5.1, 0, 0.02));
  g.add(flat(18, 0.16, mats.yellow, -32, 45, 0.02));
  g.add(flat(18, 0.16, mats.yellow, -32, 75, 0.02));

  // wheel chocks under the hero jet's main gear
  for (const z of [-1.66, 1.66]) {
    for (const dx of [-0.62, 0.62]) g.add(box(0.22, 0.14, 0.36, mats.chock, 9.6 - 11.55 + dx, 0.07, z));
  }

  // hardened aircraft shelters behind the flight line, openings facing the apron
  for (let k = 0; k < 4; k++) {
    const s = shelter(mats);
    s.position.set(-75 + k * 38, 0, 115);
    g.add(s);
  }

  // more Raptors on the flight line (geometry and materials shared with the hero jet)
  const others = [];
  for (const [x, z] of [[-32, 45], [-32, 75]]) {
    const c = jet.root.clone(true);
    c.position.set(x + 9.6, 0, z);
    c.traverse((o) => {
      if (o.isLight) o.visible = false;
    });
    g.add(c);
    const blob = flat(22, 15, mats.shadowBlob, x, z, 0.03);
    g.add(blob);
    others.push(c);
  }

  // control tower and operations building, ground equipment, lights, windsock
  const tw = tower(mats);
  tw.position.set(150, 0, 140);
  g.add(tw);
  const ft = fuelTruck(mats);
  ft.position.set(-34, 0, -24);
  ft.rotation.y = -0.35;
  g.add(ft);
  const tg = tug(mats);
  tg.position.set(18, 0, -9);
  tg.rotation.y = -0.6;
  g.add(tg);
  for (const [x, z] of [[-90, -30], [40, -30], [-90, 70], [40, 70]]) {
    const lp = lightPole(mats);
    lp.position.set(x, 0, z);
    g.add(lp);
  }
  const ws = windsock(mats);
  ws.position.set(260, 0, RZ - 50);
  g.add(ws);

  // trees: clumps scattered on the grass, kept clear of runway, taxiway and apron
  const treeGeo = new THREE.ConeGeometry(3.2, 10, 7);
  treeGeo.translate(0, 6.5, 0);
  const trunkGeo = new THREE.CylinderGeometry(0.4, 0.5, 2, 6);
  trunkGeo.translate(0, 1, 0);
  const N = 900;
  const trees = new THREE.InstancedMesh(treeGeo, mats.tree, N);
  const trunks = new THREE.InstancedMesh(trunkGeo, mats.trunk, N);
  let ti = 0;
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const q = new THREE.Quaternion();
  const sv = new THREE.Vector3();
  const pv = new THREE.Vector3();
  while (ti < N) {
    const x = (rnd() - 0.5) * 5200;
    const z = (rnd() - 0.5) * 5200;
    const clear = (Math.abs(z - RZ) < 140 && Math.abs(x) < RL / 2 + 300) || (x > -260 && x < 300 && z > -200 && z < 220);
    if (clear || fbm(x * 0.004, z * 0.004, 3) < 0.48) continue;
    const s = 0.7 + rnd() * 0.8;
    pv.set(x, 0, z);
    sv.set(s, s * (0.8 + rnd() * 0.5), s);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28);
    M.compose(pv, q, sv);
    trees.setMatrixAt(ti, M);
    trunks.setMatrixAt(ti, M);
    ti++;
  }
  trees.castShadow = true;
  g.add(trees, trunks);

  g.add(horizonHills(5000, 8500, 650, 7, mats));
  return { group: g, others };
}

/* ------------------------------ flight scene ------------------------------ */

const TILE = 48000;

export function buildFlightWorld(renderer) {
  const g = new THREE.Group();
  g.name = 'flightWorld';
  const ALT = 2600; // jet altitude above sea level (the jet stays at the origin)

  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(TILE * 4, TILE * 4),
    new THREE.MeshStandardMaterial({ color: 0x0d2433, roughness: 0.25, metalness: 0 }),
  );
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = -ALT;
  g.add(sea);

  // tileable coastline terrain: periodic in X so scrolling by one tile is seamless
  const seg = 220;
  const geo = new THREE.PlaneGeometry(TILE, TILE, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  const col = [];
  const cSand = new THREE.Color('#c9b98f');
  const cGreen = new THREE.Color('#58693a');
  const cDry = new THREE.Color('#8a7a55');
  const cRock = new THREE.Color('#77706a');
  const cSnow = new THREE.Color('#e9ecef');
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const n = fbmPeriodicX(x + TILE / 2, z, TILE, 0.00028, 7);
    // land on one side, sea on the other, with a wandering coastline in between
    const coast = (z + 6000) / 14000 + 0.18 * Math.sin((x / TILE) * Math.PI * 4);
    let h = (n - 0.42) * 3400 + coast * 900;
    h = h > 0 ? Math.pow(h / 1800, 1.35) * 1800 : h;
    p.setY(i, h);
    if (h < 18) c.copy(cSand);
    else if (h < 500) c.copy(cGreen).lerp(cDry, (h - 18) / 482);
    else if (h < 1300) c.copy(cDry).lerp(cRock, (h - 500) / 800);
    else c.copy(cRock).lerp(cSnow, Math.min(1, (h - 1300) / 400));
    const v = 0.9 + 0.2 * hash2(Math.round(x / 300), Math.round(z / 300));
    col.push(c.r * v, c.g * v, c.b * v);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const tmat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });
  const terrain = new THREE.Group();
  for (const k of [-1, 0, 1]) {
    const m = new THREE.Mesh(geo, tmat);
    m.position.set(k * TILE, -ALT, 0);
    m.receiveShadow = false;
    terrain.add(m);
  }
  g.add(terrain);

  // clouds: soft billboards spread around the jet, recycled as they stream past
  const tex = glowTex();
  const clouds = [];
  let seed = 9;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const BOX = 9000;
  for (let i = 0; i < 140; i++) {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xf2f5f8, transparent: true, opacity: 0.45 + rnd() * 0.35, depthWrite: false, toneMapped: false, fog: false }));
    const s = 250 + rnd() * 700;
    m.scale.set(s * 1.8, s * 0.7, 1);
    m.position.set((rnd() - 0.5) * BOX * 2, -ALT * 0.45 + (rnd() - 0.3) * 1400, (rnd() - 0.5) * BOX * 2);
    if (Math.abs(m.position.z) < 300 && Math.abs(m.position.y) < 200) m.position.z += 900;
    clouds.push(m);
    g.add(m);
  }
  return {
    group: g,
    /** speed in m/s along the jet's nose (+X): the world moves the other way */
    update(dt, speed) {
      const d = speed * dt;
      terrain.position.x -= d;
      if (terrain.position.x < -TILE / 2) terrain.position.x += TILE;
      for (const cl of clouds) {
        cl.position.x -= d;
        if (cl.position.x < -BOX) cl.position.x += 2 * BOX;
      }
    },
  };
}
