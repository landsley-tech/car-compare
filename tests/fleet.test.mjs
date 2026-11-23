// Car Compare. Copyright (c) 2026 Landsley Bowerman. MIT licence, see LICENSE.
// Designed by Landsley Bowerman; code written by Claude (Anthropic) from Landsley's prompts.
// SPDX-License-Identifier: MIT
// Runs every car in the full database (data/cars.db, about 30,000) and the Featured catalogue through the app's
// calculations, and checks the race model against the tested 0-60 times and top speeds in the data.
// Skipped when the database hasn't been built. Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { raceTime, estTop, grip, EVENTS, ENVS, applyMods, modsFor, yearlyCost, ulez, fits, outline, sized, carMesh, ukTax, flatten, GARAGE_DOOR } from '../web/logic.js';

const DB = fileURLToPath(new URL('../data/cars.db', import.meta.url));
const skip = existsSync(DB) ? false : 'data/cars.db not built (run python3 tools/build_db.py)';
// python is already needed to run the app, so it reads the database for us; same shape the server sends the page
const dump = `import sqlite3, json, sys
db = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True); db.row_factory = sqlite3.Row
print(json.dumps([dict(r) for r in db.execute("SELECT e.*, m.brand AS make, m.name AS model, m.year_from, m.year_to FROM engines e JOIN models m ON m.id = e.model_id")]))`;
const fleet = skip ? [] : JSON.parse(execFileSync('python3', ['-c', dump, DB], { maxBuffer: 1 << 28 })).map(r => ({
  ...r, year: r.year_from, years: [r.year_from, r.year_to],
  dims: r.length && r.width && r.height && r.wheelbase ? { length: r.length, width: r.width, height: r.height, wheelbase: r.wheelbase } : null }));
const featured = flatten(JSON.parse(readFileSync(new URL('../web/data/cars.json', import.meta.url))));
const label = c => `${c.make} ${c.model} / ${c.name ?? c.trim} (${c.year}): ${c.hp} hp, ${c.kg} kg, 0-60 ${c.z60}, top ${c.top}`;
const est = c => (c.est || '').split(',');
const sorted = a => [...a].sort((x, y) => x - y);
const median = a => sorted(a)[Math.floor(a.length / 2)], p90 = a => sorted(a)[Math.floor(a.length * 0.9)];
const NOW = new Date('2026-06-01');
// plausible limits per event, in seconds, for anything road legal from a 1900s runabout to a hypercar
// (the quickest road cars ever timed: about 1.7 s to 60, 3.2 s to 100 and 8.25 s for the quarter mile)
const LIMITS = { z60: [1.7, 80], z100: [3.1, 150], qm: [7.9, 60], r3070: [1.2, 120], roll: [1.5, 150], brake: [1.9, 5], lap: [65, 400], hill: [330, 2500] };

test('fleet: every car gives sane results in every event and condition', { skip }, () => {
  const bad = [];
  const check = (ok, c, what) => { if (!ok && bad.length < 15) bad.push(`${what}: ${label(c)}`); };
  let raced = 0;
  fleet.concat(featured).forEach((c, i) => {
    if (!c.hp || !c.kg) { for (const ev in EVENTS) check(raceTime(c, ev, 'dry') === null, c, `no power or weight but got a ${ev} time`); return; }
    raced++;
    const dry = {};
    for (const ev in EVENTS) {
      const t = dry[ev] = raceTime(c, ev, 'dry'), [lo, hi] = LIMITS[ev];
      check(t === null || (Number.isFinite(t) && t >= lo && t <= hi), c, `${ev} dry = ${t}`);
    }
    check(dry.brake != null && dry.lap != null && dry.hill != null, c, 'braking, lap and hill always have a time');
    if (c.z60) check(Math.abs(dry.z60 - c.z60) < 1e-9, c, `tested 0-60 not used (${dry.z60})`);
    if (dry.z60 != null && dry.z100 != null) check(dry.z100 > dry.z60 * 1.5, c, `0-100 (${dry.z100}) too close to 0-60 (${dry.z60})`);
    if (dry.z60 != null && dry.qm != null) check(dry.qm > dry.z60 * 0.9 || dry.z60 > 20, c, `quarter mile ${dry.qm} vs 0-60 ${dry.z60}`);
    if (dry.r3070 != null && dry.roll != null) check(dry.roll > dry.r3070 * 0.8, c, `50-100 (${dry.roll}) vs 30-70 (${dry.r3070})`);
    // conditions on every 4th car (it is the same code path, and keeps the run to a few seconds)
    if (i % 4 === 0) for (const ev in EVENTS) {
      const wet = raceTime(c, ev, 'wet'), snow = raceTime(c, ev, 'snow'), high = raceTime(c, ev, 'altitude'), hot = raceTime(c, ev, 'heat');
      for (const t of [wet, snow, high, hot]) check(t === null || (Number.isFinite(t) && t > 0), c, `${ev} in bad conditions = ${t}`);
      if (dry[ev] != null && wet != null) check(wet >= dry[ev] - 1e-9, c, `${ev} quicker in the wet`);
      if (wet != null && snow != null) check(snow >= wet - 1e-9, c, `${ev} quicker on snow than in the wet`);
      if (dry[ev] != null && hot != null) check(hot >= dry[ev] * 0.98, c, `${ev} much quicker in the heat`);
    }
    const top = estTop(c);
    check(top > 25 && top < 345, c, `estimated top speed ${top}`);
    check(grip(c) >= 0.6 && grip(c) <= 1.3, c, `grip ${grip(c)}`);
  });
  assert.deepEqual(bad, []);
  assert.ok(raced > fleet.length * 0.98, `${raced} of ${fleet.length} cars can race`);
});

test('fleet: the race model matches tested 0-60 times better than plain power-to-weight', { skip }, t => {
  const real = fleet.filter(c => c.hp && c.kg && c.z60 && c.drive && !['hp', 'kg', 'z60'].some(k => est(c).includes(k)));
  const err = f => real.map(c => Math.abs(Math.log(f(c) / c.z60)));
  const model = err(c => raceTime({ ...c, z60: null, top: null }, 'z60', 'dry') ?? 999);
  const plain = err(c => 1.05 * (c.kg / c.hp) ** 0.95 * (c.drive === 'AWD' ? 0.92 : c.drive === 'FWD' ? 1.05 : 1)); // the formula used before
  t.diagnostic(`${real.length} cars with a tested 0-60: model median error ${(median(model) * 100).toFixed(1)}%, 9 in 10 within ${(p90(model) * 100).toFixed(1)}%; `
    + `old formula ${(median(plain) * 100).toFixed(1)}% and ${(p90(plain) * 100).toFixed(1)}%`);
  assert.ok(real.length > 20000);
  assert.ok(median(model) < 0.07, 'half of all cars within 7%');
  assert.ok(p90(model) < 0.19, '9 in 10 within 19%');
  assert.ok(median(model) < median(plain) && p90(model) < p90(plain));
  // no group of cars is consistently flattered or punished by more than 5%
  for (const [name, pick] of [['FWD', c => c.drive === 'FWD'], ['RWD', c => c.drive === 'RWD'], ['AWD', c => c.drive === 'AWD'], ['turbo', c => c.asp === 'turbo'],
    ['non-turbo', c => c.asp === 'na'], ['electric', c => c.asp === 'electric'], ['pre-1970', c => c.year < 1970], ['1970-89', c => c.year >= 1970 && c.year < 1990],
    ['1990-2009', c => c.year >= 1990 && c.year < 2010], ['2010 on', c => c.year >= 2010]]) {
    const g = real.filter(pick), bias = median(g.map(c => Math.log((raceTime({ ...c, z60: null, top: null }, 'z60', 'dry') ?? 999) / c.z60)));
    assert.ok(g.length > 100 && Math.abs(bias) < 0.05, `${name}: bias ${(bias * 100).toFixed(1)}% over ${g.length} cars`);
  }
});

test('fleet: estimated top speed matches the tested figure for cars that are not speed limited', { skip }, t => {
  const tops = fleet.filter(c => c.hp && c.kg && c.top && c.dims && !est(c).includes('hp'));
  const count = {}; tops.forEach(c => { count[c.top] = (count[c.top] || 0) + 1; });
  const free = tops.filter(c => count[c.top] < tops.length * 0.012); // 155, 130, 112 mph and other limiter speeds show up as spikes
  const err = free.map(c => Math.abs(Math.log(estTop(c) / c.top)));
  t.diagnostic(`${free.length} cars: median error ${(median(err) * 100).toFixed(1)}%, 9 in 10 within ${(p90(err) * 100).toFixed(1)}%`);
  assert.ok(free.length > 5000 && median(err) < 0.05 && p90(err) < 0.14);
});

test('fleet: the database has very few figures that contradict each other', { skip }, t => {
  const withTime = fleet.filter(c => c.hp && c.kg && c.z60), ratio = c => (raceTime({ ...c, z60: null, top: null }, 'z60', 'dry') ?? 999) / c.z60;
  const off = withTime.filter(c => { const r = ratio(c); return r > 2 || r < 0.5; });
  const speed = fleet.filter(c => c.hp && c.kg && c.top && c.dims).filter(c => { const r = estTop(c) / c.top; return r > 2 || r < 0.7; });
  t.diagnostic(`0-60 that physics can't explain: ${off.length} of ${withTime.length}; top speeds: ${speed.length}`);
  for (const c of off.slice(0, 8)) t.diagnostic('  check: ' + label(c));
  assert.ok(off.length < withTime.length * 0.002, `${off.length} cars with an impossible 0-60`);
  assert.ok(speed.length < fleet.length * 0.002, `${speed.length} cars with an impossible top speed`);
  // the importer's limits hold for every row
  for (const c of fleet) {
    assert.ok(c.hp == null || (c.hp >= 5 && c.hp <= 2100), label(c));
    assert.ok(c.kg == null || (c.kg >= 300 && c.kg <= 4500), label(c));
    assert.ok(c.z60 == null || (c.z60 >= 1.7 && c.z60 <= 60), label(c));
    assert.ok(c.top == null || (c.top >= 30 && c.top <= 320), label(c));
  }
});

test('fleet: mods, costs, tax, ULEZ, fit and drawings work for every car', { skip }, () => {
  const bad = [];
  const check = (ok, c, what) => { if (!ok && bad.length < 15) bad.push(`${what}: ${label(c)}`); };
  const num = v => v === null || (Number.isFinite(v) && v >= 0);
  for (const c of fleet.concat(featured)) {
    const all = modsFor(c), tuned = applyMods(c, all);
    check(tuned.mods.length > 0 && tuned.modCost > 0, c, 'mods apply');
    if (c.hp && c.kg) {
      check(tuned.hp >= c.hp && tuned.kg < c.kg && tuned.hp < c.hp * 1.6, c, `tuned to ${tuned.hp} hp, ${tuned.kg} kg`);
      if (c.z60) check(tuned.z60 <= c.z60 && tuned.z60 > c.z60 * 0.55, c, `tuned 0-60 ${tuned.z60}`);
      if (c.top) check(tuned.top >= c.top && tuned.top < c.top * 1.2, c, `tuned top ${tuned.top}`);
      for (const ev of ['z60', 'qm', 'brake', 'lap']) {
        const a = raceTime(c, ev, 'dry'), b = raceTime(tuned, ev, 'dry');
        if (a != null) check(b != null && b <= a + 1e-9, c, `${ev}: ${a} standard, ${b} with every mod`);
      }
    }
    const cost = yearlyCost(c, undefined, NOW), tax = ukTax(c, NOW);
    check(num(cost.fuel) && num(cost.tax) && num(cost.total) && (cost.fuel ?? 0) < 20000, c, `yearly cost ${JSON.stringify(cost)}`);
    check(num(tax.annual) && typeof tax.label === 'string', c, 'tax');
    const u = ulez(c, NOW);
    check(u === null || ([true, false, null].includes(u.ok) && u.note), c, 'ulez');
    const f = fits(c.dims, GARAGE_DOOR);
    check(c.dims ? typeof f.ok === 'boolean' && Number.isFinite(f.gap) : f === null, c, 'fits');
    const o = outline(sized(c), 'side');
    check(o.w > 2000 && o.h > 800 && o.shapes.length === 3, c, 'outline');
  }
  for (const c of fleet.filter((_, i) => i % 50 === 0)) { // the 3D mesh is heavier, so every 50th car
    const m = carMesh(c);
    check(m.length > 20 && m.every(fc => fc.pts.flat().every(Number.isFinite)), c, '3D model');
  }
  assert.deepEqual(bad, []);
});

test('featured cars: the model agrees with each car\'s published 0-60 and top speed', () => {
  // runs without the database, so a fresh clone still checks the physics
  const z = featured.map(c => Math.abs(Math.log(raceTime({ ...c, z60: null, top: null }, 'z60', 'dry') / c.z60)));
  const top = featured.map(c => Math.abs(Math.log(estTop(c) / c.top)));
  assert.ok(median(z) < 0.1 && Math.max(...z) < 0.45, `0-60: median ${(median(z) * 100).toFixed(1)}%, worst ${(Math.max(...z) * 100).toFixed(1)}%`);
  assert.ok(median(top) < 0.08, `top speed: median ${(median(top) * 100).toFixed(1)}%`);
  for (const c of featured) for (const ev in EVENTS) {
    const t = raceTime(c, ev, 'dry');
    assert.ok(t === null || (t >= LIMITS[ev][0] && t <= LIMITS[ev][1]), `${ev} ${t}: ${label(c)}`);
  }
});
