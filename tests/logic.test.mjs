// Car Compare. Copyright (c) 2026 Landsley Bowerman. MIT licence, see LICENSE.
// Designed by Landsley Bowerman; code written by Claude (Anthropic) from Landsley's prompts.
// SPDX-License-Identifier: MIT
// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { esc, ukTax, raceTime, EVENTS, ENVS, outline, iconOutline, eraColours, flatten, configPrice,
  carMesh, sideDetail, PERSON, GARAGE_DOOR, grip, estTop, MODS, modsFor, modList, applyMods, yearlyCost, ulez, fits } from '../web/logic.js';

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

test('race: a slow car with a tested 0-60 stays anchored to it in every condition', () => {
  // too weak for the dry model, but thinner air at altitude lets the model through: the result must not jump about
  for (const hp of [24, 26, 28]) {
    const car = { year: 1960, hp, kg: 650, z60: 30, asp: 'turbo', box: '4-Speed Manual', drive: 'RWD' };
    assert.equal(raceTime(car, 'z60', 'dry'), 30);
    for (const env of ['altitude', 'heat']) { // was 64 s and 48 s at altitude before the fix
      const t = raceTime(car, 'z60', env);
      assert.ok(t >= 24 && t <= 40, `${hp} hp ${env}: ${t}`);
    }
    for (const env of ['wet', 'snow']) assert.ok(raceTime(car, 'z60', env) >= 30, `${hp} hp ${env} quicker than dry`);
  }
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

// Newell normal and centroid of a 3D face
const normal = pts => pts.reduce((n, a, i) => { const b = pts[(i + 1) % pts.length];
  return [n[0] + (a[1] - b[1]) * (a[2] + b[2]), n[1] + (a[2] - b[2]) * (a[0] + b[0]), n[2] + (a[0] - b[0]) * (a[1] + b[1])]; }, [0, 0, 0]);
const centre = pts => [0, 1, 2].map(k => pts.reduce((t, p) => t + p[k], 0) / pts.length);

test('3D model: real size, finite numbers, every face points outwards', () => {
  const c = byId('bmw-m4-f82:m4'), { length: L, width: W, height: H } = c.dims;
  const faces = carMesh(c), all = faces.flatMap(f => f.pts);
  for (const p of all) for (const v of p) assert.ok(Number.isFinite(v), 'NaN in mesh');
  const span = k => Math.max(...all.map(p => p[k])) - Math.min(...all.map(p => p[k]));
  assert.ok(Math.abs(span(0) - L) <= 6, 'length ' + span(0));        // lights stick out 3 mm each end
  assert.ok(Math.abs(span(1) - H * 0.98) < 10, 'height ' + span(1)); // roof at 98% of the height; 18-sided tyres stop ~5 mm off the ground
  assert.ok(Math.abs(span(2) - W) <= 20, 'width ' + span(2));        // tyres and hubs sit just proud of the body
  assert.ok(faces.every(f => f.pts.length >= 3 && ['paint', 'glass', 'tyre', 'rim', 'light', 'tail'].includes(f.kind)));
  // outward winding is what the renderer's back-face culling relies on. Checked against each part's own centre,
  // which is valid for the convex parts: the wheels, and the caps and sides of the body pieces on their own axis.
  for (const f of faces.filter(f => f.kind === 'tyre' || f.kind === 'rim')) {
    const n = normal(f.pts), [, , z] = centre(f.pts), hub = Math.sign(z) * (W / 2 + 5 - W * 0.11 / 2); // this wheel's own centre
    if (Math.abs(n[2]) > Math.abs(n[0]) + Math.abs(n[1])) assert.equal(Math.sign(n[2]), Math.sign(z - hub), 'wheel face points inwards');
  }
  for (const f of faces.filter(f => f.kind === 'paint' || f.kind === 'glass')) {
    const n = normal(f.pts), [x, y, z] = centre(f.pts);
    if (Math.abs(n[2]) > 1e-6 && Math.abs(n[0]) + Math.abs(n[1]) < 1e-6) assert.equal(Math.sign(n[2]), Math.sign(z), 'side cap points inwards');
    else if (Math.abs(n[2]) < 1e-6 && y > H * 0.9) assert.ok(n[1] > 0, 'roof points down');           // roof
    else if (Math.abs(n[2]) < 1e-6 && y < H * 0.21) assert.ok(n[1] < 0, 'floor points up');           // floor
    else if (Math.abs(n[2]) < 1e-6 && x < L * 0.02) assert.ok(n[0] < 0, 'front points backwards');    // front bumper
  }
  const front = faces.find(f => f.kind === 'light'), back = faces.find(f => f.kind === 'tail');
  assert.ok(normal(front.pts)[0] < 0 && normal(back.pts)[0] > 0, 'lights face out of the car');
  for (const body of ['sedan', 'coupe', 'hatch', 'suv', 'roadster', 'unknown']) assert.ok(carMesh({ body }).length > 50); // no dims: typical size
});

test('side drawing, person and garage door are to scale', () => {
  const c = byId('bmw-m4-f82:m4'), d = sideDetail(c);
  assert.deepEqual([d.w, d.h], [c.dims.length, c.dims.height]);
  const tyres = d.shapes.filter(s => s.class === 'tyre');
  assert.equal(tyres[1].cx - tyres[0].cx, c.dims.wheelbase);
  for (const car of [...cars, { body: 'roadster' }, { body: 'nonsense' }]) for (const s of sideDetail(car).shapes) {
    for (const [k, v] of Object.entries(s)) if (k !== 'tag' && k !== 'class') assert.doesNotMatch(String(v), /NaN|undefined/, car.id);
  }
  assert.equal(PERSON.h, 1750);
  const feet = Math.max(...PERSON.shapes[1].points.split(' ').map(p => +p.split(',')[1]));
  const head = PERSON.shapes[0].cy - PERSON.shapes[0].r;
  assert.equal(feet - head, 1745); // head to toe within 5 mm of 1.75 m
  assert.deepEqual(GARAGE_DOOR, { width: 2134, height: 1981 });
});

/* ---------- modifications, running costs, ULEZ, fit ---------- */
const GTI = { fuel: 'Petrol', asp: 'turbo', hp: 245, nm: 370, kg: 1430, z60: 6.2, top: 155, drive: 'FWD', dims: { length: 4287, width: 1789, height: 1463, wheelbase: 2631 } };

test('mods: a stage 1 remap lifts a turbo petrol far more than a non-turbo, and never touches an EV', () => {
  const t = applyMods(GTI, ['stage1']);
  assert.deepEqual([t.hp, t.nm, t.kg, t.modCost], [299, 474, 1430, 400]);
  assert.ok(t.z60 < GTI.z60 && t.z60 > 5 && t.top > GTI.top && t.top < 175);
  assert.deepEqual(t.est.split(',').sort(), ['hp', 'nm', 'top', 'z60']);  // shown with ≈ in the app
  assert.equal(applyMods({ ...GTI, asp: 'na' }, ['stage1']).hp, 262);       // 7%
  const ev = { ...GTI, fuel: 'Electric', asp: 'electric' };
  assert.equal(applyMods(ev, ['stage1', 'stage2', 'intake', 'exhaust', 'intercooler']), ev); // nothing applies: same object back
  assert.ok(!modsFor(ev).includes('stage1') && modsFor(ev).includes('tyres'));
  assert.equal(GTI.hp, 245, 'the standard car is never changed');
});

test('mods: stage 2 replaces stage 1 and brings its parts; lowering, weight and tyres feed the drawings and the race', () => {
  assert.deepEqual(modList(GTI, ['stage1', 'stage2']), ['stage2', 'intake', 'exhaust', 'intercooler']);
  assert.deepEqual(modList({ ...GTI, asp: 'na' }, ['stage2', 'intercooler', 'stage1']), ['stage1']); // no stage 2 without a turbo
  const s2 = applyMods(GTI, ['stage2']);
  assert.ok(s2.hp > 325 && s2.hp < 345 && s2.modCost === 2100);
  const chassis = applyMods(GTI, ['strip', 'wheels', 'tyres', 'suspension']);
  assert.deepEqual([chassis.kg, chassis.hp, chassis.dims.height, GTI.dims.height], [1350, 245, 1433, 1463]);
  for (const ev of ['z60', 'qm', 'lap', 'hill']) assert.ok(raceTime(chassis, ev, 'dry') < raceTime(GTI, ev, 'dry'), ev);
  assert.ok(raceTime(s2, 'roll', 'dry') < raceTime(GTI, 'roll', 'dry'));
});

test('mods: your own dyno figures win; hostile or silly input changes nothing', () => {
  const d = applyMods(GTI, ['stage1'], { hp: 310.4, nm: 480 });
  assert.deepEqual([d.hp, d.nm], [310, 480]);
  assert.ok(!d.est.split(',').includes('hp'));                             // measured, so no ≈
  for (const bad of [{ hp: -5 }, { hp: 1e9 }, { hp: NaN }, { hp: '300' }, { hp: Infinity }, null]) assert.equal(applyMods(GTI, [], bad), GTI);
  for (const ids of [['__proto__', 'constructor', '<img onerror=x>', 'toString'], 'stage1', null, undefined, [null, 5, {}]])
    assert.equal(applyMods(GTI, ids), GTI);
  const noData = applyMods({ fuel: 'Petrol', asp: 'turbo' }, ['stage1', 'strip']);
  assert.deepEqual([noData.hp, noData.kg, noData.z60], [undefined, undefined, undefined]); // no NaN or 0 invented
  assert.equal(raceTime(noData, 'z60', 'dry'), null);
});

test('yearly cost: fuel by fuel type plus tax; unknowns stay unknown', () => {
  const s = { miles: 10000, petrol: 150, diesel: 160, elec: 30 };
  const petrol = yearlyCost({ year: 2019, fuel: 'Petrol', mpg: 45.46, co2: 140 }, s, NOW);
  assert.deepEqual(petrol, { fuel: 1500, tax: 195, total: 1695 });           // 220 gallons = 1,000 litres at £1.50
  assert.equal(yearlyCost({ year: 2019, fuel: 'Diesel', mpg: 45.46, co2: 120 }, s, NOW).fuel, 1600);
  assert.equal(yearlyCost({ year: 2022, fuel: 'Electric', batt: 75, range: 300, co2: 0 }, s, NOW).fuel, 750); // 0.25 kWh a mile
  assert.ok(yearlyCost({ year: 2020, fuel: 'Electric', mpg: 156, co2: 0 }, s, NOW).fuel > 600);               // EPA cars: from MPGe
  assert.equal(yearlyCost({ year: 2022, fuel: 'Plug-in hybrid', mpg: 200, co2: 30 }, s, NOW).fuel, null);
  assert.deepEqual(yearlyCost({ year: 2019, fuel: 'Petrol' }, s, NOW), { fuel: null, tax: null, total: null });
});

test('ULEZ rule of thumb: petrol from 2006, diesel from 2016, EVs and historic cars pass', () => {
  const u = (year, fuel, years) => ulez({ year, fuel, years }, NOW)?.ok;
  assert.deepEqual([u(2006, 'Petrol'), u(2005, 'Petrol'), u(2016, 'Diesel'), u(2015, 'Diesel'), u(2012, 'Hybrid')], [true, false, true, false, true]);
  assert.equal(u(2003, 'Petrol', [2003, 2008]), null);                       // on sale either side of the cut-off
  assert.equal(u(2012, 'Diesel', [2012, null]), null);                       // still on sale
  assert.deepEqual([u(1970, 'Petrol'), u(1985, 'Diesel'), u(1986, 'Diesel'), u(2019, 'Electric')], [true, true, false, true]);
  assert.equal(ulez({ fuel: 'Petrol' }, NOW), null);
});

test('fits: checks width, height and (if given) length, and warns when mirrors make it tight', () => {
  const d = GTI.dims;
  assert.deepEqual([fits(d, GARAGE_DOOR).ok, fits(d, GARAGE_DOOR).tight], [true, false]); // 345 mm spare
  assert.equal(fits(d, { width: 1900, height: 1981 }).tight, true);
  const low = fits(d, { width: 2134, height: 1400 });
  assert.deepEqual([low.ok, low.worst, low.gap], [false, 'height', -63]);
  assert.equal(fits(d, { width: 2134, height: 1981, length: 4000 }).worst, 'length');
  assert.equal(fits(null, GARAGE_DOOR), null);
  assert.equal(fits(applyMods(GTI, ['suspension']).dims, { width: 2134, height: 1440 }).ok, true); // 30 mm lower now clears it
});

/* ---------- physics model and the review-style events ---------- */
const M4 = byId('bmw-m4-f82:m4'), BEETLE = byId('vw-beetle-54:1200'), TESLA = byId('tesla-model3:p');

test('race events: 0-100, 30-70 and braking behave like the real tests', () => {
  for (const c of [M4, TESLA, GTI]) {
    const [z60, z100, qm, mid, roll] = ['z60', 'z100', 'qm', 'r3070', 'roll'].map(ev => raceTime(c, ev, 'dry'));
    assert.ok(z100 > z60 * 1.8 && z100 < z60 * 3.2, `${c.id}: 0-100 ${z100} vs 0-60 ${z60}`);
    assert.ok(qm > z60 + 5 && qm < z60 + 11, `${c.id}: quarter mile ${qm}`);
    assert.ok(mid < roll && mid > 1.5, `${c.id}: 30-70 ${mid}, 50-100 ${roll}`);
  }
  assert.ok(Math.abs(raceTime(M4, 'qm', 'dry') - 12.2) < 0.8, 'M4 quarter mile is about 12.2 s in road tests');
  assert.ok(Math.abs(raceTime(M4, 'z100', 'dry') - 8.8) < 1.2, 'M4 0-100 is about 8.8 s in road tests');
  // a 1950s Beetle tops out near 70 mph: it can sprint to 60 but never sees 100
  assert.ok(raceTime(BEETLE, 'z60', 'dry') > 25);
  assert.equal(raceTime(BEETLE, 'z100', 'dry'), null);
  assert.ok(raceTime(BEETLE, 'qm', 'dry') > 21);
});

test('braking: modern tyres stop in about 35 m from 60, old ones need far longer, wet and snow longer still', () => {
  const stop = (c, env = 'dry') => EVENTS.brake.metres(raceTime(c, 'brake', env));
  assert.ok(stop(M4) > 29 && stop(M4) < 36, `M4 ${stop(M4)} m`);
  assert.ok(stop(BEETLE) > 45 && stop(BEETLE) < 60, `Beetle ${stop(BEETLE)} m`);
  assert.ok(stop(M4, 'wet') > stop(M4) * 1.3 && stop(M4, 'snow') > stop(M4) * 3);
  assert.ok(stop(applyMods(GTI, ['tyres', 'brakes'])) < stop(GTI));
  assert.ok(grip({ year: 1955, hp: 30, kg: 700 }) < grip({ year: 1985, hp: 100, kg: 1000 }) && grip({ year: 1985, hp: 100, kg: 1000 }) < grip({ year: 2020, hp: 500, kg: 1500 }));
});

test('physics: traction, thin air and drag pull the right way', () => {
  const car = { year: 2018, fuel: 'Petrol', asp: 'na', hp: 400, kg: 1500, box: '6-Speed Manual', body: 'coupe' };
  const t = (drive, env, ev = 'z60') => raceTime({ ...car, drive }, ev, env);
  assert.ok(t('AWD', 'snow') < t('RWD', 'snow') && t('AWD', 'wet') < t('FWD', 'wet'));    // four driven wheels win when it's slippery
  assert.ok(t('RWD', 'dry') < t('FWD', 'dry'));                                           // weight moves backwards under power
  assert.ok(t('RWD', 'altitude', 'z100') > t('RWD', 'dry', 'z100'));                      // 25% less power beats 22% less drag
  assert.ok(raceTime({ ...car, drive: 'RWD', fuel: 'Electric', asp: 'electric' }, 'z100', 'altitude') < t('RWD', 'dry', 'z100') * 1.02); // an EV loses nothing, and gains from thin air
  assert.ok(estTop({ ...car, body: 'suv' }) < estTop({ ...car, body: 'coupe' }));         // a blunt body is slower flat out
  assert.ok(estTop({ ...car, hp: 800 }) < estTop(car) * 1.3);                             // double the power is nowhere near double the speed
  assert.ok(raceTime({ ...car, drive: 'RWD', box: '8-Speed Automatic' }, 'z100', 'dry') < t('RWD', 'dry', 'z100')); // quicker shifts
  assert.equal(raceTime({ ...car, drive: 'RWD', hp: 8, kg: 2500 }, 'z100', 'dry'), null);  // 8 hp in 2.5 tonnes never gets to 100
});

/* ---------- stylesheet: secure, and motion only for people who want it ---------- */
test('style.css loads nothing from outside and keeps every movement behind prefers-reduced-motion', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /@import/i, 'no @import');
  assert.doesNotMatch(css, /javascript:|expression\s*\(|(?<![-\w])behavior\s*:|-moz-binding/i, 'no script in CSS');
  for (const [, u] of css.matchAll(/url\(\s*["']?([^"')]+)/g)) assert.match(u, /^data:image\/svg\+xml,/, 'only inline SVG images: ' + u.slice(0, 40));
  // cut out every "@media (prefers-reduced-motion: no-preference) { ... }" block (matching braces), then check what's left
  let rest = css;
  for (let i; (i = rest.search(/@media\s*\(prefers-reduced-motion:\s*no-preference\)/)) >= 0;) {
    let depth = 0, j = rest.indexOf('{', i);
    for (; j < rest.length; j++) { if (rest[j] === '{') depth++; else if (rest[j] === '}' && --depth === 0) break; }
    rest = rest.slice(0, i) + rest.slice(j + 1);
  }
  assert.doesNotMatch(rest, /(^|[;{\s])animation(-name)?\s*:/, 'an animation runs even with reduced motion');
  for (const [t] of rest.matchAll(/transition\s*:[^;}]*/g)) assert.doesNotMatch(t, /transform|translate|scale|rotate|width|all\b/, 'movement outside the guard: ' + t);
  assert.ok(/@media \(prefers-reduced-motion: no-preference\) \{\n  :root \{ --ease/.test(css), 'motion section present');
});

