// Car Compare. Copyright (c) 2026 Landsley Bowerman. MIT licence, see LICENSE.
// Designed by Landsley Bowerman; code written by Claude (Anthropic) from Landsley's prompts.
// SPDX-License-Identifier: MIT
// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { esc, ukTax, raceTime, EVENTS, ENVS, outline, iconOutline, eraColours, flatten, configPrice } from '../web/logic.js';

const models = JSON.parse(readFileSync(new URL('../web/data/cars.json', import.meta.url)));
const cars = flatten(models);
const byId = id => cars.find(c => c.id === id);
const NOW = new Date('2026-06-01');

test('esc neutralises HTML/attribute injection', () => {
  assert.equal(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(esc(`" onmouseover='x' &`), '&quot; onmouseover=&#39;x&#39; &amp;');
  assert.equal(esc(null), '');
  assert.equal(esc(42), '42');
});

test('UK tax: historic, pre-2001, CO2 bands, post-2017 and supplement', () => {
  assert.equal(ukTax({ year: 1965, cc: 4700 }, NOW).annual, 0);
  assert.equal(ukTax({ year: 1985, cc: 2000 }, NOW).annual, 0);       // 41 years old in 2026
  assert.equal(ukTax({ year: 1995, cc: 1242 }, NOW).annual, 220);
  assert.equal(ukTax({ year: 1995, cc: 1549 }, NOW).annual, 220);     // boundary
  assert.equal(ukTax({ year: 1995, cc: 1550 }, NOW).annual, 360);
  assert.equal(ukTax({ year: 2005, co2: 255 }, NOW).annual, 735);     // band L
  assert.equal(ukTax({ year: 2005, co2: 256 }, NOW).annual, 760);     // band M
  assert.equal(ukTax({ year: 2010, co2: 99 }, NOW).annual, 20);       // band A
  const m4 = ukTax({ year: 2018, co2: 194, price: 57000 }, NOW);
  assert.deepEqual([m4.annual, m4.firstYear], [620, 3300]);
  const cheapEv = ukTax({ year: 2022, co2: 0, price: 35000 }, NOW);
  assert.deepEqual([cheapEv.annual, cheapEv.firstYear], [195, 10]);
  assert.equal(ukTax({ year: 2022, co2: 0, price: 40001 }, NOW).annual, 620);
  assert.equal(ukTax({ year: 2010 }, NOW).annual, null);              // no CO2: unknown, not a guess
  assert.equal(ukTax({ year: 1995 }, NOW).annual, null);
});

test('race: known 0-60 is used in the dry', () => {
  assert.equal(raceTime(byId('bmw-m4-f82:m4'), 'z60', 'dry'), 3.9);
});

test('race: rain hurts RWD more than AWD', () => {
  const m4 = byId('bmw-m4-f82:m4'), s3 = byId('audi-a3-8y:s3');
  const pen = c => raceTime(c, 'qm', 'wet') / raceTime(c, 'qm', 'dry');
  assert.ok(pen(m4) > pen(s3));
  assert.ok(raceTime(m4, 'z60', 'snow') > raceTime(s3, 'z60', 'snow'));
});

test('race: altitude hurts non-turbo engines most, EVs least', () => {
  const pen = c => raceTime(c, 'hill', 'altitude') / raceTime(c, 'hill', 'dry');
  const na = byId('bmw-m3-e30:23'), turbo = byId('bmw-m4-f82:m4'), ev = byId('tesla-model3:p');
  assert.ok(pen(na) > pen(turbo) && pen(turbo) > pen(ev));
  assert.equal(pen(ev), 1);
});

test('race: quicker cars win the drag race and the lap', () => {
  const fast = byId('bmw-m4-f82:m4'), slow = byId('vw-beetle-54:1200');
  for (const ev of ['qm', 'lap', 'hill']) assert.ok(raceTime(fast, ev, 'dry') < raceTime(slow, ev, 'dry'), ev);
});

test('race: missing data or too-low top speed gives null, never NaN', () => {
  assert.equal(raceTime({ make: 'EPA car' }, 'qm', 'dry'), null);
  assert.equal(raceTime(byId('vw-beetle-54:1200'), 'roll', 'dry'), null);
  assert.equal(raceTime(byId('bmw-m4-f82:m4'), 'bogus', 'dry'), null);
  for (const c of cars) for (const ev in EVENTS) for (const env in ENVS) {
    const t = raceTime(c, ev, env);
    assert.ok(t === null || (Number.isFinite(t) && t > 0), `${c.id} ${ev} ${env}`);
  }
});

test('outlines are to scale and wheels sit a wheelbase apart', () => {
  const c = byId('bmw-m4-f82:m4');
  const side = outline(c, 'side');
  assert.deepEqual([side.w, side.h], [4671, 1383]);
  const [a, b] = side.shapes.filter(s => s.tag === 'circle');
  assert.equal(b.cx - a.cx, 2812);
  for (const view of ['front', 'rear']) assert.deepEqual([outline(c, view).w, outline(c, view).h], [1870, 1383]);
  assert.deepEqual([outline(c, 'top').w, outline(c, 'top').h], [4671, 1870]);
  for (const car of cars) for (const v of ['side', 'front', 'rear', 'top'])
    for (const s of outline(car, v).shapes)
      for (const [k, val] of Object.entries(s)) if (k !== 'tag') assert.doesNotMatch(String(val), /NaN|undefined/, `${car.id} ${v}`);
});

test('configured price ignores tampered option names', () => {
  const c = byId('bmw-m4-f82:m4');
  assert.equal(configPrice(c, 'Sakhir Orange', ["M Driver's Package (174 mph)"]), 57000 + 645 + 1950);
  assert.equal(configPrice(c, 'Not a colour', ['<script>', 'Free car']), 57000);
});

test('catalogue data integrity', () => {
  const FUELS = ['Petrol', 'Diesel', 'Hybrid', 'Plug-in hybrid', 'Electric'];
  const ids = new Set();
  for (const m of models) {
    assert.ok(m.id && m.make && m.model && m.gen, m.id);
    assert.ok(m.years[0] >= 1950 && m.years[0] <= 2026 && m.years[1] >= m.years[0], m.id);
    assert.ok(['sedan', 'coupe', 'hatch', 'suv', 'roadster'].includes(m.body), m.id);
    const d = m.dims;
    assert.ok(d.length > 2500 && d.width > 1200 && d.height > 1000 && d.wheelbase < d.length, m.id);
    assert.ok(m.colours.length >= 3 && m.addons.length >= 3, m.id);
    for (const k of m.colours) assert.match(k.hex, /^#[0-9a-f]{6}$/i, `${m.id} ${k.name}`);
    for (const a of [...m.colours, ...m.addons]) assert.ok(Number.isInteger(a.price) && a.price >= 0, `${m.id} ${a.name}`);
  }
  for (const c of cars) {
    assert.ok(!ids.has(c.id), 'duplicate ' + c.id); ids.add(c.id);
    assert.ok(FUELS.includes(c.fuel), c.id);
    assert.ok(['RWD', 'FWD', 'AWD'].includes(c.drive), c.id);
    assert.ok(['na', 'turbo', 'electric'].includes(c.asp), c.id);
    for (const k of ['hp', 'nm', 'kg', 'z60', 'top', 'price']) assert.ok(c[k] > 0, `${c.id} ${k}`);
    assert.ok(c.hp / c.kg < 0.35, `${c.id} power-to-weight looks wrong`);
    assert.ok(c.year >= c.years[0] && c.year <= c.years[1], `${c.id} year`);
    if (c.fuel === 'Electric') assert.ok(c.range && c.co2 === 0, c.id);
    else assert.ok(c.tank > 0 && c.cc > 0 && c.mpg > 0, c.id);
  }
  const decades = new Set(cars.map(c => Math.floor(c.year / 10) * 10));
  for (let d = 1950; d <= 2020; d += 10) assert.ok(decades.has(d), `no cars from the ${d}s`);
});

test('database cars: unknown price and unknown top speed are handled honestly', () => {
  const t = ukTax({ year: 2020, co2: 150 }, NOW);
  assert.equal(t.annual, 195);
  assert.match(t.note, /List price unknown/);
  const noTop = { hp: 300, kg: 1500, drive: 'AWD', asp: 'turbo', top: null };
  assert.ok(raceTime(noTop, 'roll', 'dry') > 0); // unknown top speed is not treated as "too slow"
});

test('historic exemption rolls forward on 1 April, not 1 January', () => {
  assert.notEqual(ukTax({ year: 1986, cc: 2000 }, new Date('2027-02-15')).annual, 0);  // tax year 2026/27: 1986 not exempt
  assert.equal(ukTax({ year: 1986, cc: 2000 }, new Date('2027-04-15')).annual, 0);     // tax year 2027/28: exempt
  assert.equal(ukTax({ year: 1985, cc: 2000 }, new Date('2027-02-15')).annual, 0);
});

test('every car gets colours and an icon, even without data', () => {
  for (const y of [1899, 1955, 1975, 1995, 2024, undefined]) {
    const cs = eraColours(y);
    assert.ok(cs.length >= 5);
    for (const c of cs) assert.match(c.hex, /^#[0-9a-f]{6}$/i);
  }
  assert.equal(eraColours(1975)[0].name, 'Harvest Gold');
  for (const body of ['sedan', 'coupe', 'hatch', 'suv', 'roadster', 'unknown']) assert.ok(iconOutline({ body }).w > 0);
});
