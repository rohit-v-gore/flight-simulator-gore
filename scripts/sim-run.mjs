#!/usr/bin/env node
/*
 * Sim Lab batch runner: flies test cards headlessly with the scripted test pilot and writes reports.
 *
 *   npm run sim                                    # every automatable card, every eligible aircraft
 *   npm run sim -- --aircraft airliner --card takeoff,engine-out
 *   npm run sim -- --card takeoff --set isaDevC=25,windKt=10,windFrom=160
 *   npm run sim -- --aircraft seaglider --card cruise --sweep massPct=80:120:10
 *   npm run sim -- --scenario scenario.json        # a scenario saved from the game's report screen
 *
 * Output: reports/<timestamp>/summary.md, summary.json, and one <run>.csv flight-data file per run.
 * Exit code 1 if any run fails its criteria (useful in CI when airframe data changes).
 */
import fs from 'node:fs';
import path from 'node:path';
import { GamePhysics, AIRFRAMES } from '../src/game/physics.js';
import * as W from '../src/game/gameWorld.js';
import { TEST_CARDS, cardById, cardConditions, prepareRun, ScenarioRun, parseScenario, describeConditions, CONDITION_FIELDS } from '../src/sim/scenario.js';
import { TestPilot } from '../src/sim/testPilot.js';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
if (args.includes('--help') || args.includes('-h')) {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('*/')[0].replace(/^#!.*\n\/\*\n?/, '').replace(/^ \* ?/gm, ''));
  console.log('Cards:', TEST_CARDS.map((c) => `${c.id}${c.manual ? ' (manual)' : ''}`).join(', '));
  console.log('Conditions:', CONDITION_FIELDS.map((f) => `${f[0]} (${f[2] || '#'})`).join(', '));
  process.exit(0);
}

const world = { groundAt: W.groundAt, surfaceHeight: W.surfaceHeight, surfaceAt: W.surfaceAt, runwayAt: W.runwayAt, ends: W.runwayEnds(), docks: W.spawnPoints().docks };

const parseKV = (str) =>
  Object.fromEntries((str || '').split(',').filter(Boolean).map((kv) => {
    const [k, v] = kv.split('=');
    if (!CONDITION_FIELDS.some((f) => f[0] === k)) throw new Error(`Unknown condition "${k}". Known: ${CONDITION_FIELDS.map((f) => f[0]).join(', ')}`);
    return [k, Number(v)];
  }));

/** Build the list of scenarios to fly. */
function plan() {
  const scen = opt('scenario');
  if (scen) {
    const s = parseScenario(JSON.parse(fs.readFileSync(scen, 'utf8')));
    if (!s) throw new Error(`Not a valid scenario: ${scen}`);
    if (s.mode !== 'test' || cardById(s.card)?.manual) throw new Error('The batch runner flies automatable test cards only (takeoff, engine-out, hot-high, cruise, accel).');
    return [{ ...s, label: '' }];
  }
  const ids = (opt('aircraft') || 'all') === 'all' ? Object.keys(AIRFRAMES) : opt('aircraft').split(',');
  const cards = (opt('card') || 'all') === 'all' ? TEST_CARDS.filter((c) => !c.manual) : opt('card').split(',').map((id) => cardById(id) || (() => { throw new Error(`Unknown card "${id}"`); })());
  const set = parseKV(opt('set'));
  let sweep = [{}];
  if (opt('sweep')) {
    const [k, range] = opt('sweep').split('=');
    const [a, b, step] = range.split(':').map(Number);
    if (!CONDITION_FIELDS.some((f) => f[0] === k) || !(step > 0)) throw new Error('--sweep key=from:to:step, e.g. massPct=80:120:10');
    sweep = [];
    for (let v = a; v <= b + 1e-9; v += step) sweep.push({ [k]: Math.round(v * 1000) / 1000 });
  }
  const runs = [];
  for (const card of cards) {
    if (card.manual) {
      console.warn(`Skipping "${card.id}": flown by a pilot in the game, not by the batch runner.`);
      continue;
    }
    for (const id of ids) {
      if (!AIRFRAMES[id]) throw new Error(`Unknown aircraft "${id}". Known: ${Object.keys(AIRFRAMES).join(', ')}`);
      if (!card.aircraft.includes(id)) continue;
      for (const sw of sweep) {
        const cond = { ...cardConditions(card, id, world), ...set, ...sw };
        runs.push({ aircraft: id, mode: 'test', card: card.id, from: null, to: null, cond, label: Object.entries(sw).map(([k, v]) => `${k}=${v}`).join(' ') });
      }
    }
  }
  return runs;
}

function fly(setup) {
  const physics = new GamePhysics(world, setup.aircraft);
  const { card, cond, ctx } = prepareRun(physics, world, setup);
  const run = new ScenarioRun({ physics, setup: { ...setup, cond }, card, ctx, cond });
  const pilot = new TestPilot(physics, card, ctx);
  const dt = 1 / 60;
  const limit = 60 * 60 * 20; // 20 simulated minutes
  for (let i = 0; i < limit; i++) {
    pilot.fly(dt);
    physics.step(dt);
    physics.events.length = 0;
    if (run.update(dt)) break;
  }
  if (run.status === 'running') run.finish('timeout', 'Time limit reached');
  return run;
}

const runs = plan();
if (!runs.length) {
  console.error('Nothing to run (check --aircraft / --card).');
  process.exit(2);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.resolve(opt('out') || path.join('reports', stamp));
fs.mkdirSync(outDir, { recursive: true });

const KEY = ['ground_roll_m', 'takeoff_distance_35ft_m', 'liftoff_ias_kt', 'time_to_1000ft_agl_s', 'max_track_deviation_deg', 'fuel_kg', 'fuel_kg_per_nm', 'energy_kwh', 'energy_kwh_per_nm', 'max_mach', 'time_in_band_pct'];
const rows = [];
const reports = [];
const t0 = Date.now();
for (const setup of runs) {
  const run = fly(setup);
  const rep = run.report();
  const name = [setup.aircraft, setup.card, setup.label.replace(/[^a-z0-9=.-]+/gi, '_')].filter(Boolean).join('-');
  fs.writeFileSync(path.join(outDir, `${name}.csv`), run.rec.toCSV());
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(rep, null, 2));
  reports.push(rep);
  const m = rep.metrics;
  if (run.card.id === 'accel' && run.reached != null) m.time_to_target_mach_s = Math.round(run.reached);
  rows.push({ name, verdict: rep.result.verdict, card: run.card.name, aircraft: AIRFRAMES[setup.aircraft].name, cond: describeConditions(rep.scenario.conditions), m, criteria: rep.criteria });
  const keys = [...KEY, 'time_to_target_mach_s'].filter((k) => m[k] != null).map((k) => `${k}=${m[k]}`).join('  ');
  console.log(`${rep.result.verdict.padEnd(10)} ${name.padEnd(42)} ${keys}`);
  for (const c of rep.criteria) if (!c.pass) console.log(`           ✗ ${c.label}: ${c.value}`);
}

const md = [
  '# Sim Lab batch report',
  '',
  `Generated ${new Date().toISOString()} · ${rows.length} runs · ${((Date.now() - t0) / 1000).toFixed(1)} s wall time`,
  '',
  '| Result | Card | Aircraft | Conditions | Key results |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map((r) => `| **${r.verdict}** | ${r.card} | ${r.aircraft} | ${r.cond} | ${[...KEY, 'time_to_target_mach_s'].filter((k) => r.m[k] != null).map((k) => `${k.replace(/_/g, ' ')}: ${r.m[k]}`).join('<br>')} |`),
  '',
  '## Criteria',
  '',
  ...rows.flatMap((r) => [`### ${r.name} · ${r.verdict}`, '', ...r.criteria.map((c) => `- ${c.pass ? '✅' : '❌'} ${c.label}: ${c.value}`), '']),
].join('\n');
fs.writeFileSync(path.join(outDir, 'summary.md'), md);
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(reports.map(({ events, channels, ...r }) => r), null, 2));
console.log(`\nReports: ${path.relative(process.cwd(), outDir)}/summary.md (+ JSON and CSV flight data per run)`);
process.exit(rows.some((r) => r.verdict !== 'PASS') ? 1 : 0);
