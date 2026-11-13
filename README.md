# F-22 Raptor

A procedural F-22A Raptor for the browser, built in [Three.js](https://threejs.org/): every surface is generated from published dimensions in code, with no 3D model files or image textures. It has working control surfaces, 2D thrust-vectoring nozzles, internal weapons bays and landing gear, a world to sit in, and a CesiumJS page where it flies a demo sortie over Edwards AFB on real terrain.

It is also the visual front end for a planned aerial test and simulation platform (see [System design](#system-design)).

![F-22 in flight over a procedural coastline, afterburners lit](docs/hero.jpg)

## Play

`npm run dev`, then open **http://localhost:5173**: the flight game.

- **Tutorial** (start here): 16 interactive steps. Release the brake, throttle up, light the burner, rotate at 140 kt, gear and flaps up, climb, level off, turn to Lakeside Field, configure for landing, read the PAPI lights, flare, touch down and brake to a stop. Each step waits until you've actually done it.
- **Free flight**: lined up on runway 09 at Raptor AFB; fly anywhere and land at either airport.
- **Landing challenge**: start 5 nm out on final to Lakeside Field and get scored on the touchdown.

The world is 80 × 80 km of terrain and coast with two airports. Each runway has markings, edge and approach lights, and PAPI glide-slope lights that change colour with your angle. The game shows a green HUD (pitch ladder, flight-path marker, speed, altitude, heading, vertical speed, G) and draws synthetic runway outlines to help you find the field. You also get a status panel, a map with your waypoint, on-screen controls (H hides them) and a pause menu with every key (Esc).

The flight model is fly-by-wire like the real jet: ↓/↑ ask for G, so a centred stick holds your flight path, and ←/→ roll and hold the bank. On the ground there's thrust, friction, brakes and nose-wheel steering, and the gear is locked down by weight on wheels. Touchdowns are graded Butter, Smooth or Firm. Gear up, too much sink, wings not level, nose first, water or rough ground means a crash.

| Key | Action |
| --- | --- |
| `↓` `↑` | Pull / push (G) |
| `←` `→` | Roll |
| `A` `D` | Rudder / nose-wheel steering |
| `W` `S` | Throttle up / down |
| `X` | Afterburner |
| `Space` · `P` | Wheel brakes (hold) · parking brake |
| `G` · `F` / `Shift+F` · `B` | Gear · flaps down / up · speed brake |
| `O` · `K` · `C` | Weapons bays · thrust vectoring · canopy (stopped) |
| `V` · `R` · `H` · `Esc` | Camera (chase / cockpit / orbit) · restart · hide controls · pause |

Other pages: **hangar.html** to inspect the jet and its systems up close, **flight.html** for the CesiumJS demo sortie over real Edwards AFB terrain.

## What's in it

**The aircraft**
- Chined fuselage, caret intakes with raked lips, a 42° diamond wing with a forward-swept trailing edge, twin tails canted 28°, notched stabilators and a frameless gold-tinted canopy.
- Moving parts: stabilators, ailerons, flaperons, leading-edge flaps, rudders, gear with sawtooth doors, canopy, arresting hook, bay doors and missile launchers.
- **Thrust vectoring:** upper and lower nozzle flaps deflect ±20° together with the stick; they also open in afterburner. The plume follows the nozzle.
- **Weapons bays:** the main bay opens and its launchers push six AIM-120s clear; the side bays swing an AIM-9 out on a trapeze.
- **Control mixing and interlocks:** speed brake as a surface mix (ailerons up, flaperons down, rudders toed out); high lift retracts above Mach 0.6; with weight on wheels the gear handle is locked down.
- Paint: two-tone grey camouflage or plain test-fleet grey, painted procedurally onto a texture atlas and projected onto the airframe.

**The hangar** (hangar.html)
- An air base: runway with markings and edge lights, taxiway, aircraft shelters, control tower, ground vehicles, more parked Raptors, trees and hills.
- In flight: procedural terrain, coastline and clouds that stream past at the jet's speed.

| Air base | In flight |
| --- | --- |
| ![Flight line with shelters, parked Raptors and ground equipment](docs/airbase.jpg) | ![F-22 over terrain and coast](docs/flight.jpg) |

![Weapons bays open, canopy up](docs/systems.jpg)

**The flight page** (CesiumJS)
- The same model, exported to glTF at startup, flying a scripted sortie from Edwards AFB runway 04R: afterburner takeoff, a slow high-alpha pass on thrust vectoring, a fast pass with the bays open, then an approach and landing on 22L, and repeat.
- Take over at any time (**P**) and fly it: point-mass flight model with standard atmosphere, afterburner thrust, drag from gear, flaps, speed brake and open bays, ground roll and brakes.

![F-22 climbing out of Edwards AFB in CesiumJS](docs/cesium.jpg)

## Run it

Needs Node.js 20.19+ (or 22.12+) and a WebGL 2 browser.

```bash
npm install
npm run dev          # game: http://localhost:5173 · hangar: /hangar.html · globe flight: /flight.html
npm run build        # production build in dist/
```

The flight page loads CesiumJS from a CDN. For your own Cesium ion token (optional), copy `.env.example` to `.env` and fill it in. Flight page options: `?mode=manual`, `?camera=cockpit|flyby|free`, `?livery=ghost`, `?buildings=0`, `?shadows=0`.

### Viewer controls

| Key | Action |
| --- | --- |
| `W` / `S` | Main weapons bay / side bays |
| `V` | Thrust vectoring on/off |
| `F` | High lift: up → takeoff → landing |
| `G` `C` `H` `B` | Gear (locked down on the ground) · canopy · hook · speed brake |
| `A` | Afterburner |
| Arrows · `Q` `E` | Stick · rudder |
| `L` · `R` | Lights · auto-rotate |
| `1`–`8` | Camera views (incl. nozzles and weapons bays close-ups) |

The panel on the right has everything else: Mach, demos (control exerciser, post-stall pitch, bay cycle), paint, ferry tanks, scene, sun and exposure.

### Flight controls

`P` demo/manual · `V` camera · `T` time ×1/×2/×4 · `R` restart · `H` help · `↓`/`↑` pull/push · `←`/`→` roll · `Q`/`E` rudder and nosewheel · `W`/`S` throttle · `A` afterburner · `Space` brakes · `G` gear · `F` flaps · `B` speed brake · `O` bays · `K` thrust vectoring · `C` canopy (stopped).

## System design

### How it works today

<p align="center"><img src="docs/diagrams/today.png" width="900" alt="Procedural model modules feed F22.js, which drives the Three.js viewer and a GLB export animated in Cesium by a point-mass flight model and demo autopilot" /></p>

- **One model, two front ends.** `src/f22` builds the aircraft; `F22.js` turns commands (stick, throttle, switches) into actuator positions at realistic rates, with control mixing and interlocks. The viewer renders it directly; the flight page exports it to glTF and animates the same parts.
- **Physics is deliberately simple today**: a point-mass model good for demos and driving the visuals, not for engineering answers.

### Toward an aerial test and simulation platform

<p align="center"><img src="docs/diagrams/platform.png" width="900" alt="Test cards feed an orchestrator running fixed-step sims (environment, 6-DOF dynamics, sensors, flight control laws with SIL/HIL) that stream telemetry to storage for analysis and replay and to 3D clients" /></p>

| Layer | What it adds | Notes |
| --- | --- | --- |
| Test cards | Scenarios as data: initial conditions, manoeuvres, disturbances, pass/fail criteria | Versioned with the code so results are reproducible |
| Orchestrator | Many headless runs, faster than real time: sweeps, Monte Carlo, CI on every change | The same scenario runs in batch or with a pilot in the loop |
| 6-DOF flight dynamics | Aero tables, engine and mass models on a fixed time step | An open-source FDM such as JSBSim fits here; `flightModel.js` is the placeholder |
| Flight control and sensors | Control laws, actuator limits, IMU / air data / GPS / radar models | Software-in-the-loop runs real flight code; hardware-in-the-loop swaps in real avionics |
| Telemetry | Every signal of every run on a bus and in a time-series store | The 3D views become subscribers, so live view and replay share one stream |
| Analysis and replay | Automatic criteria checks and reports; scrub any run in 3D | The HUDs already render state; they need a data source instead of a local sim |

First steps: put the sim behind a state stream (WebSocket) that the viewers consume; replace the point-mass model with 6-DOF dynamics; define a test-card format and a headless runner; then record runs and add replay.

## Project layout

```
index.html, src/game/       the flight game: physics, world (terrain, airports, PAPI), HUD, missions, tutorial
hangar.html, src/main.js    hangar viewer: scene, light, panel, HUD, keyboard, demos
src/world/world.js          air base, flight terrain, clouds
src/f22/
  F22.js                    assembly, commands → actuators, control mixing, interlocks
  dims.js                   reference geometry (wing, tails, gear, nozzles)
  body.js · wing.js · tail.js · engine.js · bays.js · gear.js · cockpit.js
  geom.js · util.js         lofting, sections, hinges, interpolation
  livery.js · materials.js  paint atlas and the projection shader
flight.html, src/flight/
  main.js                   Cesium viewer, model sync, cameras, HUD, keys
  flightModel.js            point-mass flight model (120 Hz)
  autopilot.js              runway geometry and the demo sortie
  exportModel.js            Three.js → GLB with the paint baked to UVs
docs/                       screenshots and diagrams (Mermaid sources included)
```

`window.__f22` in the viewer exposes the jet, scene and camera for console tinkering.

## Notes

This is a visual model, not a certified simulator. Dimensions follow published F-22 figures (length 18.92 m, span 13.56 m, height 5.08 m); many details are simplified for real-time rendering. The flight model's numbers are F-22-class estimates, not manufacturer data.

## License

[MIT](LICENSE) © Rohit Gore
