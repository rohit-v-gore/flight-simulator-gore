# Sim Lab reference

Sim Lab turns United Coast from a game into a scenario simulator. You set up a flight as data, fly it by hand or with a scripted pilot, record it, and grade it against pass/fail criteria. Each run produces a report and raw data you can analyse elsewhere.

The same code runs in the browser and in Node, so a scenario flown by hand in the game can be re-run in batch with the same physics and grading.

## Concepts

| Term | Meaning |
| --- | --- |
| **Scenario** | `{ aircraft, mode, card, from, to, cond }`. Fully describes a flight. It is saved as JSON or encoded in a link (`?scenario=…`). |
| **Conditions** (`cond`) | Weather, airframe changes and failures (below). |
| **Test card** | A start condition, a scripted-pilot procedure, an end condition and a list of pass/fail criteria. |
| **Run** | One flight of a scenario. It records data, triggers failures, decides when the card is complete, and builds the report. |
| **Verdict** | `PASS` / `FAIL` / `INCOMPLETE` (ended early) / `RECORDED` (no criteria, e.g. free flight) / `CRASH` |

## Conditions

| Key | Unit | Range | Effect |
| --- | --- | --- | --- |
| `windKt` | kt | 0–60 | Wind speed at 10 m. It grows with height using a power-law surface layer (exponent 0.14). |
| `windFrom` | ° | 0–359 | Direction the wind blows **from** (compass) |
| `gustKt` | kt | 0–30 | Amplitude of gusts along, across and vertically (smooth, multi-frequency) |
| `isaDevC` | °C | −40–45 | Temperature deviation from ISA. Warmer air is thinner: less lift and thrust, higher true airspeed for the same indicated airspeed. |
| `massPct` | % | 60–140 | Aircraft mass. Vr and Vapp scale with √(mass / CLmax). |
| `thrustPct` | % | 50–150 | Installed thrust (dry and reheat; propeller power for the seaglider) |
| `dragPct` | % | 50–200 | Zero-lift drag and wave drag |
| `clMaxPct` | % | 60–140 | Maximum lift coefficient in every flap setting |
| `failEngines` | count | 0–engines | Engines (seaglider: motors) that fail. Failed engines are on the left wing, so the aircraft yaws left. |
| `failAtKt` | KIAS | 0–1500 | Indicated airspeed at which the failure happens (0 = from the start) |

## Test cards

| Card | Aircraft | Start | Ends | Criteria |
| --- | --- | --- | --- | --- |
| `takeoff` | all | runway / dock, parking brake set | 1,500 ft AGL (seaglider: 30 s after liftoff) | lifts off; clears 35 ft within the runway available (seaglider: lifts off within 3,000 m); no crash |
| `engine-out` | all | runway / dock; 1 engine (2 motors) fails at 0.95 Vr | 1,000 ft AGL (seaglider: 45 s after liftoff) | as above, plus reaches 1,000 ft AGL (seaglider: holds 15–45 ft for 80% of the flight); track within 15° of the runway heading |
| `crosswind` | all, **pilot-flown** | final approach; direct crosswind 18 kt with ±8 kt gusts (seaglider 10 / ±4) | stopped | on the runway or water; sink within 60% of the airframe's limit; crab ≤ 5°; touchdown zone 150–900 m (Concorde 1,200 m); stopped |
| `hot-high` | F-22, Concorde, airliner | Denver, ISA+25 °C | 1,500 ft AGL | as `takeoff` |
| `cruise` | all | airborne on the over-water range at the cruise point | after 20 nm (seaglider 10 nm) | flies the leg; holds altitude ±300 ft (seaglider 15–45 ft) for 90%; no supersonic flight over land; reports fuel or energy per nm |
| `accel` | F-22, Concorde | M0.95 at 36,000 / 45,000 ft | target Mach (1.6 / 1.8) | reaches the target in time (180 s / 360 s); no supersonic flight over land; reports fuel |

**Cruise points:**

| Aircraft | Cruise point |
| --- | --- |
| F-22 | M0.9 at 30,000 ft |
| Concorde | M2.0 at 52,000 ft |
| Airliner | M0.78 at 35,000 ft |
| Seaglider | 130 kt at 30 ft |

The **over-water test range** runs south along x = −84 km, west of the west coast. It is all ocean, so a supersonic test there causes no sonic boom over land.

## The flight data recorder

There are 28 channels, sampled at 10 Hz:

| Group | Channels |
| --- | --- |
| Time and position | `t_s`, `x_m`, `z_m` |
| Height | `alt_ft`, `agl_ft` |
| Speed | `ias_kt`, `tas_kt`, `gs_kt`, `mach`, `vs_fpm` |
| Attitude | `hdg_deg`, `pitch_deg`, `bank_deg`, `aoa_deg`, `nz_g` |
| Engines | `throttle_%`, `ab`, `thrust_kN` |
| Pilot inputs | `stick_pitch`, `stick_roll`, `rudder` |
| Configuration | `gear`, `flaps`, `on_surface`, `engines_failed` |
| Consumption and distance | `fuel_kg`, `energy_kWh`, `dist_nm` |

Position `x` points east and `z` points south, in metres from the map centre.

**Events:** `start`, `brake_release`, `engine_failure`, `liftoff`, `screen_35ft`, `climb_1000ft_agl`, `touchdown`, `stopped`, `crash`, `end`.

Metrics in the report and JSON are rounded:

| Group | Metrics |
| --- | --- |
| Takeoff | `ground_roll_m`, `takeoff_distance_35ft_m`, `liftoff_ias_kt`, `liftoff_time_s`, `time_to_1000ft_agl_s`, `max_track_deviation_deg` |
| Landing | `touchdown_sink_fpm`, `touchdown_ias_kt`, `touchdown_crab_deg`, `touchdown_past_threshold_m`, `landing_roll_m` |
| Consumption | `fuel_kg`, `fuel_kg_per_nm`, `energy_kwh`, `energy_kwh_per_nm` |
| Envelope | `max_mach`, `avg_mach_airborne`, `max_ias_kt`, `max_alt_ft`, `max_g`, `min_g`, `max_aoa_deg`, `max_bank_deg` |
| Height band and boom | `time_in_band_pct`, `supersonic_over_land_s` |

## In the browser

1. Choose an aircraft, then **Test card** and a card.
2. Open **Conditions** to see or change the card's defaults.
3. Press **Fly**.

The objective panel shows the criteria as a live checklist, and the status panel shows wind, temperature, fuel or energy, failures, and **REC**. The run ends by itself when the card is complete. To stop early, press **Esc** and then **End & report**; this works for any flight.

The report shows:
- the verdict and the criteria
- every metric, with deltas against your previous run of the same aircraft and scenario (▲ better, ▼ worse)
- altitude, airspeed and G charts, with event markers and a hover readout
- downloads: **CSV** flight data, **JSON** report, **scenario** file, and **Copy scenario link**

The menu's **Recent runs** keeps the last 30 runs in this browser. **Load scenario…** accepts a scenario file or a downloaded report.

## Batch runner

```bash
npm run sim -- --help
npm run sim                                                     # all automatable cards × eligible aircraft
npm run sim -- --aircraft f22,concorde --card accel
npm run sim -- --card takeoff --set isaDevC=20,massPct=110      # override conditions
npm run sim -- --aircraft airliner --card takeoff --sweep massPct=80:120:10
npm run sim -- --scenario scenario.json --out reports/today     # a scenario saved from the game
```

The scripted test pilot flies each card the same way every time:
- **Departures:** full power, rotate at Vr, fixed climb path, gear and flaps up.
- **Test points:** altitude hold, plus speed hold or full reheat.
- **Height hold (seaglider):** the flight computer does it.

`crosswind` is a pilot-flown card, so the batch runner skips it.

**Output:** `summary.md` (a table and the criteria per run), `summary.json`, and a `<aircraft>-<card>[-sweep].json` and `.csv` per run. The exit code is 1 if any run is not `PASS`, so you can gate changes to airframe data in CI.

## Adding a card

Cards live in `TEST_CARDS` in `src/sim/scenario.js`. Each one needs:
- `id`, `name`, `aircraft[]`, `summary` and `pilot`
- `start`: `departure`, `final` or `test-point`, with `point(id)`
- optionally `conditions(ac, ctx)` (defaults), `band(ac, id)` (a height band for `time_in_band_pct`) and `fromCity`
- `end(run)` and `criteria(ac, ctx)`

Each criterion is `{ label, test(metrics, recorder, run) → { ok, value } }`. Set `manual: true` if the scripted pilot can't fly it.

## Adding an aircraft

1. Add airframe data to `AIRFRAMES` in `src/game/physics.js`. Besides the aerodynamic and mass data, include:
   - `engines`
   - `tsfc` / `tsfcAb`, or `electric`, `thrustPower` and `driveEff`
   - `ram` and `asymYaw`
2. Add a model that follows `src/aircraft/CONTRACT.md`.
3. Register the model in `AIRCRAFT` in `src/game/main.js`.

Every card that lists the aircraft then works for it in the game and in batch.

## Fidelity

The physics is a point-mass, wind-axes model at 120 Hz:
- ISA atmosphere, plus temperature deviation
- lift and drag build-ups with flaps, gear and speed brake
- transonic wave drag and ground effect
- thrust lapse with density, ram recovery and engine-out asymmetry
- propeller thrust limited by power (seaglider)
- fuel from TSFC, and battery energy from thrust power and drive efficiency

It reproduces the right trends and realistic magnitudes. For example, cruise burn is about 22 kg/nm for Concorde at Mach 2 and about 5 kg/nm for an A320-class airliner. It is still not certified engineering data.

For programme decisions, add a 6-DOF model with the manufacturer's aero tables and engine decks, using the same scenario, recorder and grading layers (see the README's system design).
