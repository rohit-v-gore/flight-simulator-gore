# Aircraft model contract

Every flyable aircraft is a module in `src/aircraft/` exporting `create(renderer)`:

```js
export function create(renderer) {
  return {
    id: 'concorde',            // short id
    name: 'Concorde',          // display name
    root,                      // THREE.Group. Origin = ground-contact point under the main gear with the
                               // gear down (for the seaglider: hull keel bottom). Nose points +X, Y up,
                               // starboard (right wing) +Z. Units: metres.
    eye: [x, y, z],            // pilot's eye position in root-local coordinates (for the cockpit camera)
    chaseDistance: 30,         // a good chase-camera distance (m)
    update(dt, s) {},          // pose the model every frame from state s (see below)
  };
}
```

State `s` passed to `update`:

| field | type | meaning |
| --- | --- | --- |
| gearDown | bool | landing gear (seaglider: hydrofoil) extended. Animate over ~5 s. |
| flaps | 'up' \| 'takeoff' \| 'landing' | high-lift setting |
| throttle | 0..1 | engine power (animate fan spin / prop spin / exhaust glow) |
| afterburner | 0..1 | reheat (Concorde & F-22 only) |
| pitch, roll, yaw | -1..1 | pilot inputs (deflect elevators/elevons, ailerons, rudder) |
| speedBrake | bool | spoilers / speed brake |
| onGround | bool | on wheels (or floating on the hull) |
| speed | m/s | airspeed (e.g. Concorde droop nose: down below ~130 m/s with gear down) |
| time | s | running time for spinning props etc. |

Rules: three.js only (`three` and `three/addons/*`). You may reuse `src/f22/geom.js` and `src/f22/util.js`
helpers (loft, sectionRing, ellipseRing, makeHinge, T/Tp...). Paint with plain materials or your own canvas
textures (no airline or company logos/brands — use fictional names). Aim for < 250k triangles and < 400 ms
build time. Cast/receive shadows on main meshes.

Preview any model at `http://localhost:5173/aircraft-preview.html?model=<file name without .js>`.
