import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { F22 } from '../f22/F22.js';
import { isLiveryMaterial, ATLAS, RANGE } from '../f22/materials.js';

/*
 * Turn the procedural F-22 into a self-contained GLB for engines that can't run our shaders.
 * The livery shader blends four projected views of one atlas; here each triangle instead picks its
 * best-facing view and gets real UVs into the same atlas, so a plain textured material reproduces it.
 */

const NO_GPU = { capabilities: { getMaxAnisotropy: () => 8 } };

/** Atlas UV of design point (s, y, w) in one of the four views. */
function atlasUV(view, s, y, w) {
  const R = RANGE;
  const fs = (s - R.s0) / R.S;
  const fy = (y - R.y0) / R.Y;
  const fw = (w - R.w0) / R.W;
  const r = ATLAS[view];
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  let u;
  let v;
  if (view === 'top') [u, v] = [fy, fs];
  else if (view === 'bottom') [u, v] = [1 - fy, fs];
  else if (view === 'stbd') [u, v] = [1 - fs, 1 - fw];
  else [u, v] = [fs, 1 - fw];
  return [(r.x + clamp01(u) * r.w) / ATLAS.w, (r.y + clamp01(v) * r.h) / ATLAS.h];
}

/** Non-indexed copy of a livery geometry with per-triangle projected UVs. */
function unwrapLivery(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.computeVertexNormals();
  const ref = g.attributes.aRef;
  const nrm = g.attributes.normal;
  const uv = new Float32Array(ref.count * 2);
  for (let t = 0; t < ref.count; t += 3) {
    // average normal in the design frame: (s, y, w) = (-x, z, y)
    let ns = 0;
    let ny = 0;
    let nw = 0;
    let ys = 0;
    for (let k = 0; k < 3; k++) {
      ns -= nrm.getX(t + k);
      ny += nrm.getZ(t + k);
      nw += nrm.getY(t + k);
      ys += ref.getY(t + k);
    }
    const ax = Math.abs(ns);
    const ay = Math.abs(ny);
    const aw = Math.abs(nw);
    let view;
    if (aw >= ay && aw >= ax) view = nw > 0 ? 'top' : 'bottom';
    else if (ay >= ax) view = ny > 0 ? 'stbd' : 'port';
    else view = ys >= 0 ? 'stbd' : 'port';
    for (let k = 0; k < 3; k++) {
      const [u, v] = atlasUV(view, ref.getX(t + k), ref.getY(t + k), ref.getZ(t + k));
      uv[2 * (t + k)] = u;
      uv[2 * (t + k) + 1] = v;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.deleteAttribute('aRef');
  return g;
}

/**
 * Build the jet and export it. Returns the GLB, the live jet (drive it with jet.update) and a map
 * from glTF node name to the three.js object whose local matrix that node should follow.
 */
export async function exportJet({ livery = 'raptor' } = {}) {
  const jet = new F22(NO_GPU, { livery });
  const mats = jet.mats;
  const atlas = new THREE.CanvasTexture(mats.livery.canvas);
  atlas.flipY = false;
  atlas.colorSpace = THREE.SRGBColorSpace;

  const swap = new Map();
  const portable = (mat) => {
    if (swap.has(mat)) return swap.get(mat);
    let out = mat;
    if (isLiveryMaterial(mat)) {
      out = new THREE.MeshStandardMaterial({ map: atlas, roughness: mat.roughness, metalness: mat.metalness, side: mat.side });
    } else if (mat.isShaderMaterial) {
      // afterburner layers: bright, translucent, unlit
      const hot = mat === mats.flameCore ? 0xfff0c8 : mat === mats.flameMid ? 0xffb050 : 0xff7a2e;
      const alpha = mat === mats.flameCore ? 0.75 : mat === mats.flameMid ? 0.45 : 0.25;
      out = new THREE.MeshBasicMaterial({ color: hot, transparent: true, opacity: alpha, depthWrite: false, side: THREE.DoubleSide });
    } else if (mat.isMeshStandardMaterial && mat.emissiveIntensity > 1) {
      out = mat.clone();
      out.emissiveIntensity = 1;
    }
    swap.set(mat, out);
    return out;
  };

  const unwrapped = new Map();
  const remove = [];
  jet.root.traverse((o) => {
    if (o.isLight) remove.push(o);
    if (!o.isMesh) return;
    if (o.material === mats.glassReflect) {
      remove.push(o);
      return;
    }
    if (isLiveryMaterial(o.material) && o.geometry.attributes.aRef) {
      if (!unwrapped.has(o.geometry)) unwrapped.set(o.geometry, unwrapLivery(o.geometry));
      o.geometry = unwrapped.get(o.geometry);
    } else if (o.geometry.attributes.aRef) {
      o.geometry = o.geometry.clone();
      o.geometry.deleteAttribute('aRef');
    }
    o.material = portable(o.material);
  });
  remove.forEach((o) => o.removeFromParent());

  // unique node names so the engine side can find every animated part
  const nodes = new Map();
  let id = 0;
  jet.root.traverse((o) => {
    o.name = `n${id++}`;
    nodes.set(o.name, o);
  });

  jet.update(0, true);
  jet.root.updateMatrixWorld(true);
  const glb = await new GLTFExporter().parseAsync(jet.root, { binary: true, onlyVisible: false, maxTextureSize: 4096 });
  return { glb, jet, nodes };
}
