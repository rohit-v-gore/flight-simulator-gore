import * as THREE from 'three';
import { ATLAS, RANGE, SCHEMES, paintLivery } from './livery.js';

/*
 * Materials. Painted skin uses a MeshStandardMaterial whose base colour is looked up in the livery atlas:
 * each fragment blends the top/bottom/side views by how much its design-frame normal faces each way.
 * Geometry carries its design coordinates in the `aRef` attribute (see geom.finalize).
 */

const reg = (r) => new THREE.Vector4(r.x / ATLAS.w, r.y / ATLAS.h, r.w / ATLAS.w, r.h / ATLAS.h);

function makeLiveryUniforms() {
  return {
    uAtlas: { value: null },
    uRange: { value: new THREE.Vector4(RANGE.s0, RANGE.S, RANGE.y0, RANGE.Y) },
    uRangeW: { value: new THREE.Vector2(RANGE.w0, RANGE.W) },
    uTop: { value: reg(ATLAS.top) },
    uBottom: { value: reg(ATLAS.bottom) },
    uStbd: { value: reg(ATLAS.stbd) },
    uPort: { value: reg(ATLAS.port) },
    uPad: { value: new THREE.Vector2(2 / ATLAS.w, 2 / ATLAS.h) },
  };
}

const LIVERY_VERT_HEAD = /* glsl */ `
attribute vec3 aRef;
varying vec3 vDesign;
varying vec3 vDesignN;
`;

// design normal = (s, y, w) = (-x, z, y) of the object-space normal
const LIVERY_VERT_BODY = /* glsl */ `
vDesign = aRef;
vDesignN = vec3(-objectNormal.x, objectNormal.z, objectNormal.y);
`;

const LIVERY_FRAG_HEAD = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec4 uRange;   // s0, S, y0, Y
uniform vec2 uRangeW;  // w0, W
uniform vec4 uTop, uBottom, uStbd, uPort; // atlas regions: x, y, w, h (0..1)
uniform vec2 uPad;
varying vec3 vDesign;
varying vec3 vDesignN;

vec3 atlasAt(vec4 region, vec2 f) {
  vec2 uv = region.xy + clamp(f, vec2(0.0), vec2(1.0)) * region.zw;
  uv = clamp(uv, region.xy + uPad, region.xy + region.zw - uPad);
  return texture2D(uAtlas, uv).rgb;
}

vec3 liveryColour() {
  vec3 p = vDesign;
  vec3 n = normalize(vDesignN);
  float fs = (p.x - uRange.x) / uRange.y;
  float fy = (p.y - uRange.z) / uRange.w;
  float fw = (p.z - uRangeW.x) / uRangeW.y;
  vec3 top = atlasAt(uTop, vec2(fy, fs));
  vec3 bottom = atlasAt(uBottom, vec2(1.0 - fy, fs));
  vec3 stbd = atlasAt(uStbd, vec2(1.0 - fs, 1.0 - fw));
  vec3 port = atlasAt(uPort, vec2(fs, 1.0 - fw));
  // fore/aft-facing surfaces take the side view of their own side
  float endOn = pow(abs(n.x), 4.0);
  float wTop = pow(max(n.z, 0.0), 4.0);
  float wBottom = pow(max(-n.z, 0.0), 4.0);
  float wStbd = pow(max(n.y, 0.0), 4.0) + (p.y >= 0.0 ? endOn : 0.0);
  float wPort = pow(max(-n.y, 0.0), 4.0) + (p.y < 0.0 ? endOn : 0.0);
  return (top * wTop + bottom * wBottom + stbd * wStbd + port * wPort) / (wTop + wBottom + wStbd + wPort + 1e-5);
}
`;

function liveryMaterial(uniforms, params = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0.1, ...params });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${LIVERY_VERT_HEAD}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${LIVERY_VERT_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${LIVERY_FRAG_HEAD}`)
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= liveryColour();');
  };
  mat.customProgramCacheKey = () => 'f22-livery-atlas';
  mat.userData.livery = true;
  return mat;
}

/* ----------------------------- Afterburner flame ----------------------------- */

const FLAME_VERT = /* glsl */ `
varying vec2 vUv;
varying float vFacing;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vFacing = abs(dot(normalize(normalMatrix * normal), normalize(-mv.xyz)));
  gl_Position = projectionMatrix * mv;
}
`;

const FLAME_FRAG = /* glsl */ `
uniform float uTime;
uniform float uHeat;
uniform float uGain;
uniform float uDiamonds;
uniform vec3 uNear;
uniform vec3 uFar;
varying vec2 vUv;
varying float vFacing;
void main() {
  float along = clamp(vUv.y, 0.0, 1.0);            // 0 at the nozzle, 1 at the tip
  float fade = pow(1.0 - along, 1.7) * smoothstep(0.0, 0.06, along + 0.02);
  float core = pow(vFacing, 1.8);                  // bright through the middle, soft at the rim
  float ripple = 0.82 + 0.18 * sin(along * 46.0 - uTime * 55.0 + vUv.x * 18.85);
  float shock = mix(1.0, 0.6 + 0.4 * pow(cos(along * 3.14159 * uDiamonds), 2.0), uDiamonds > 0.0 ? 1.0 - along : 0.0);
  float k = fade * core * ripple * shock * uHeat * uGain;
  gl_FragColor = vec4(mix(uNear, uFar, smoothstep(0.0, 0.85, along)) * k, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function flameMaterial({ near, far, gain, diamonds = 0 }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uHeat: { value: 0 },
      uGain: { value: gain },
      uDiamonds: { value: diamonds },
      uNear: { value: new THREE.Color(near) },
      uFar: { value: new THREE.Color(far) },
    },
    vertexShader: FLAME_VERT,
    fragmentShader: FLAME_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/** Black/yellow hazard stripes for the ejection handles. */
function hazardStripes() {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 2;
  const ctx = c.getContext('2d');
  for (let x = 0; x < 32; x += 8) {
    ctx.fillStyle = '#e3b21c';
    ctx.fillRect(x, 0, 4, 2);
    ctx.fillStyle = '#161616';
    ctx.fillRect(x + 4, 0, 4, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(4, 1);
  return t;
}

/* ---------------------------------- Factory ---------------------------------- */

export function createMaterials(renderer, schemeKey = 'raptor') {
  const anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  const U = makeLiveryUniforms();
  const std = (p) => new THREE.MeshStandardMaterial(p);
  const m = {
    body: liveryMaterial(U),
    bodyDouble: liveryMaterial(U, { side: THREE.DoubleSide }),
    wing: liveryMaterial(U),

    metal: std({ color: 0x8c8f92, metalness: 0.85, roughness: 0.36 }),
    metalDark: std({ color: 0x393b3e, metalness: 0.6, roughness: 0.55 }),
    chrome: std({ color: 0xe0e0e0, metalness: 1, roughness: 0.12 }),
    duct: std({ color: 0xffffff, vertexColors: true, metalness: 0, roughness: 0.75 }),
    nozzleSolid: std({ color: 0x4f5357, metalness: 0.55, roughness: 0.5 }),
    nozzleLiner: std({ color: 0x1a1918, metalness: 0.3, roughness: 0.85, side: THREE.DoubleSide, envMapIntensity: 0.1 }),

    gear: std({ color: 0xe6e6e1, metalness: 0.05, roughness: 0.5 }),
    rubber: std({ color: 0x1b1b1b, roughness: 0.92, side: THREE.DoubleSide }),
    hub: std({ color: 0xcdcdc8, metalness: 0.35, roughness: 0.45 }),
    well: std({ color: 0xd6d5cf, roughness: 0.75, side: THREE.DoubleSide }),
    bay: std({ color: 0xb9bcbd, metalness: 0.1, roughness: 0.7, side: THREE.BackSide }),
    lamp: std({ color: 0xffffff, emissive: 0xfff3dc, emissiveIntensity: 0, metalness: 0.3, roughness: 0.1 }),

    navRed: std({ color: 0xff2a1f, emissive: 0xff1a10, emissiveIntensity: 2, roughness: 0.25 }),
    navGreen: std({ color: 0x2aff5a, emissive: 0x10ff40, emissiveIntensity: 2, roughness: 0.25 }),
    navWhite: std({ color: 0xffffff, emissive: 0xfffbf2, emissiveIntensity: 1.6, roughness: 0.3 }),
    beacon: std({ color: 0xff2010, emissive: 0xff1000, emissiveIntensity: 0, roughness: 0.2 }),
    formation: std({ color: 0x9fd8a4, emissive: 0x50ff70, emissiveIntensity: 0, roughness: 0.4 }),

    frame: std({ color: 0x6d747a, metalness: 0.12, roughness: 0.58 }),
    cockpit: std({ color: 0x2c2f33, roughness: 0.82 }),
    coaming: std({ color: 0x1b1c1e, roughness: 0.95 }),
    consoleTop: std({ color: 0x3a3e43, roughness: 0.7 }),
    display: std({ color: 0x081009, emissive: 0x40d47e, emissiveIntensity: 0.2, metalness: 0.15, roughness: 0.14 }),
    mfd: std({ color: 0x0a0d10, emissive: 0x4a90c8, emissiveIntensity: 0.22, metalness: 0.2, roughness: 0.12 }),
    gauge: std({ color: 0x0d0e10, metalness: 0.12, roughness: 0.28 }),
    hud: std({
      color: 0xa6ffc6, emissive: 0x36ff78, emissiveIntensity: 0.4, transparent: true, opacity: 0.25, depthWrite: false,
      side: THREE.DoubleSide, roughness: 0.04,
    }),
    seat: std({ color: 0x2b2c2f, metalness: 0.08, roughness: 0.78 }),
    seatPad: std({ color: 0x5d5538, roughness: 0.9 }),
    yellowBlack: std({ color: 0xffffff, map: hazardStripes(), roughness: 0.5 }),
    suit: std({ color: 0x55593c, roughness: 0.92 }),
    harness: std({ color: 0x3b4029, roughness: 0.85 }),
    helmet: std({ color: 0x8e9296, roughness: 0.35 }),
    mask: std({ color: 0x262626, roughness: 0.6 }),
    visorGold: std({ color: 0xd8a540, metalness: 1, roughness: 0.12 }),

    // indium-tin-oxide canopy: a faint gold tint plus an additive reflection layer
    glassTint: new THREE.MeshBasicMaterial({ color: 0x8a6a2a, transparent: true, opacity: 0.24, depthWrite: false, side: THREE.DoubleSide }),
    glassReflect: std({
      color: 0x000000, metalness: 0, roughness: 0.04, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, envMapIntensity: 1.5,
    }),

    paintLower: std({ color: 0x80878d, metalness: 0.08, roughness: 0.62 }),
    missileWhite: std({ color: 0xecece7, metalness: 0.04, roughness: 0.42 }),
    missileGrey: std({ color: 0x989ca0, metalness: 0.12, roughness: 0.52 }),
    seeker: std({ color: 0x14171b, metalness: 0.25, roughness: 0.18 }),
    bandYellow: std({ color: 0xd9a81c, roughness: 0.5 }),
    bandBrown: std({ color: 0x6b4a2b, roughness: 0.6 }),

    flameHolder: std({ color: 0x1e1c1a, emissive: 0xff621e, emissiveIntensity: 0.1, metalness: 0.45, roughness: 0.62 }),
    flameOuter: flameMaterial({ near: 0xff8a3c, far: 0x7a2a8a, gain: 0.55 }),
    flameMid: flameMaterial({ near: 0xffc070, far: 0xff5520, gain: 0.9, diamonds: 4 }),
    flameCore: flameMaterial({ near: 0xfff2d0, far: 0xffa040, gain: 1.6, diamonds: 4 }),
  };
  m.store = m.paintLower;

  const flames = [m.flameOuter, m.flameMid, m.flameCore];
  m.setFlame = (heat, time) => {
    for (const f of flames) {
      f.uniforms.uHeat.value = heat;
      f.uniforms.uTime.value = time;
    }
  };

  let atlas = null;
  /** Repaint the livery atlas with a scheme from SCHEMES. */
  m.setLivery = (key, opts = {}) => {
    const { canvas, scheme } = paintLivery(key, opts);
    if (atlas) atlas.dispose();
    atlas = new THREE.CanvasTexture(canvas);
    atlas.colorSpace = THREE.SRGBColorSpace;
    atlas.flipY = false;
    atlas.anisotropy = anisotropy;
    atlas.minFilter = THREE.LinearMipmapLinearFilter;
    U.uAtlas.value = atlas;
    m.paintLower.color.set(scheme.lower);
    m.frame.color.set(scheme.base);
    m.livery = { canvas, texture: atlas, scheme };
    return scheme;
  };
  m.setLivery(schemeKey);
  m.schemes = SCHEMES;
  return m;
}

export function isLiveryMaterial(mat) {
  return Boolean(mat && mat.userData && mat.userData.livery);
}

export { ATLAS, RANGE };
