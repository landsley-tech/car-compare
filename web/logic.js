// Car Compare. Copyright (c) 2026 Landsley Bowerman. MIT licence, see LICENSE.
// Designed by Landsley Bowerman; code written by Claude (Anthropic) from Landsley's prompts.
// SPDX-License-Identifier: MIT
// Pure functions shared by the app and the tests (node --test tests/).

export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ---------- UK Vehicle Excise Duty (car tax), 2025/26 rates ---------- */
// ponytail: rates are hard-coded for 2025/26; update these tables each April from gov.uk/vehicle-tax-rate-tables.
const FIRST_YEAR = [[0, 10], [50, 110], [75, 130], [90, 270], [100, 350], [110, 390], [130, 440], [150, 540],
  [170, 1360], [190, 2190], [225, 3300], [255, 4690], [Infinity, 5490]];
const BANDS_2001 = [['A', 100, 20], ['B', 110, 20], ['C', 120, 35], ['D', 130, 165], ['E', 140, 195], ['F', 150, 215],
  ['G', 165, 265], ['H', 175, 315], ['I', 185, 345], ['J', 200, 395], ['K', 225, 430], ['L', 255, 735], ['M', Infinity, 760]];

// car: { year, fuel, co2 (g/km), cc, price (£ new) }. Registration date is approximated by model year.
export function ukTax(car, now = new Date()) {
  const { year, co2, cc, price } = car;
  if (!year) return { label: 'Unknown', annual: null, note: 'No year' };
  const taxYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear(); // UK tax years start 1 April
  if (year <= taxYear - 41) // historic: built before 1 January, 40 years before the tax year started
    return { label: 'Historic (exempt)', annual: 0, note: 'Free to tax: built over 40 years ago' };
  if (year < 2001) {
    if (!cc) return { label: 'Pre-2001', annual: null, note: 'Needs engine size' };
    return cc <= 1549 ? { label: 'Pre-2001, up to 1549cc', annual: 220, note: 'Taxed on engine size' }
                      : { label: 'Pre-2001, over 1549cc', annual: 360, note: 'Taxed on engine size' };
  }
  if (co2 == null) return { label: 'Unknown', annual: null, note: 'No CO2 figure' };
  if (year < 2017) {
    const [band, , annual] = BANDS_2001.find(([, max]) => co2 <= max);
    return { label: `Band ${band} (${co2} g/km)`, annual, note: 'Taxed on CO2 band' };
  }
  const firstYear = FIRST_YEAR.find(([max]) => co2 <= max)[1];
  const supplement = price > 40000 ? 425 : 0;
  return { label: supplement ? 'Standard + expensive car supplement' : 'Standard rate', annual: 195 + supplement, firstYear,
    note: supplement ? 'List price over £40,000: +£425 a year in years 2–6'
      : price == null ? 'List price unknown: add £425 a year in years 2–6 if it was over £40,000' : 'Flat rate after the first year' };
}

/* ---------- Race model ---------- */
// Estimates only. Known 0–60 times are used where we have them; the rest comes from power-to-weight.
export const EVENTS = {
  z60:   { label: '0–60 mph', note: 'Standing start', k: 2, to: 60 },
  z100:  { label: '0–100 mph', note: 'Standing start, through the gears', k: 1.8, to: 100 },
  qm:    { label: '¼ mile', note: '402 m from a standing start', k: 1.6, dist: 402.336 },
  r3070: { label: '30–70 mph', note: 'Rolling start: the overtaking test', k: 1.4, from: 30, to: 70 },
  roll:  { label: '50–100 mph', note: 'Rolling start, side by side at 50 mph', k: 1.3, from: 50, to: 100 },
  brake: { label: 'Braking 60–0 mph', note: 'Emergency stop from 60 mph: first to stop wins', k: 0.6, metres: t => 60 * MPH * t / 2 },
  lap:   { label: 'Circuit lap', note: 'One flying lap of a 2.5 km club circuit', launch: 0.25, power: 0.3, k: 1 },
  hill:  { label: 'Mountain pass', note: '8 km uphill run, hairpins and all', launch: 0.25, power: 0.5, k: 1 },
};
// mu scales tyre grip and air scales air density, for the physics model. grip and base are for the lap and hill formulas.
export const ENVS = {
  dry:      { label: 'Dry', grip: 0, base: 1, mu: 1, air: 1, note: 'Warm, dry tarmac' },
  wet:      { label: 'Wet', grip: 1, base: 1.07, mu: 0.7, air: 1, note: 'Standing water: traction decides it' },
  snow:     { label: 'Snow', grip: 3, base: 1.3, mu: 0.3, air: 1, note: 'Packed snow on winter tyres' },
  altitude: { label: 'High altitude', grip: 0, base: 1, mu: 1, air: 0.78, note: '2,500 m: thin air hurts non-turbo engines' },
  heat:     { label: 'Desert heat', grip: 0, base: 1.01, mu: 0.97, air: 0.93, note: '45 °C: heat soak cuts power' },
};
const TRACTION = { RWD: 0.045, FWD: 0.035, AWD: 0.01 };
const POWER_LOSS = { altitude: { na: 0.25, turbo: 0.08, electric: 0 }, heat: { na: 0.06, turbo: 0.08, electric: 0.04 } };

/* ---------- acceleration and braking: a small physics model ---------- */
// each 0.02 s step: push = the smaller of what the tyres can take and what the engine gives, minus air drag and rolling drag.
// the numbers in TUNE were fitted to the tested 0-60 times and top speeds in the full database (see tests/fleet.test.mjs).
const G = 9.81, MPH = 0.44704, DRIVER = 75; // m/s2, m/s per mph, kg
export const TUNE = {
  eff: { na: 0.68, turbo: 0.76, electric: 0.95 }, // share of peak power that reaches the road, averaged over the rev range
  awd: 0.95,                // four-wheel drive loses a bit more in the drivetrain
  gross: 0.9,               // before 1972 power was quoted "gross" (engine on a stand, no ancillaries), so real power was lower
  v1: 7.2, vEv: 15.2,       // m/s. below this the engine can't give full power yet (first gear / motor torque limit)
  shiftManual: 0.39, shiftAuto: 0.24, t0: 0.38, // seconds lost per gear change, and getting off the line
  effTop: 0.81,             // share of peak power available flat out in top gear
};
const SHIFT_AT = [15, 27.5, 40, 54, 70]; // m/s: about 34, 62, 90, 121 and 157 mph
const CD = { sedan: 0.3, coupe: 0.31, hatch: 0.32, suv: 0.36, roadster: 0.37 };
const yearOf = car => car.year ?? car.years?.[0] ?? 2010;
const powerKind = car => car.fuel === 'Electric' || car.asp === 'electric' ? 'electric' : car.asp === 'turbo' ? 'turbo' : 'na';

// Tyre grip (peak friction): tyres improved a lot by era, and fast cars come on stickier ones.
export function grip(car) {
  const y = yearOf(car), era = y < 1950 ? 0.65 : y < 1965 ? 0.72 : y < 1980 ? 0.8 : y < 1995 ? 0.88 : y < 2010 ? 0.95 : 1;
  return era + Math.min(0.2, Math.max(0, ((car.hp / car.kg) * 1000 - 150) / 1000 || 0));
}
// drag area (Cd x frontal area, m2) from body style, era and real width x height
function dragArea(car) {
  const d = sized(car).dims, y = yearOf(car);
  return ((CD[car.body] ?? 0.32) + (y < 1980 ? 0.1 : y < 2000 ? 0.03 : 0)) * 0.85 * d.width * d.height / 1e6;
}
const dragK = (car, env) => 0.5 * 1.225 * (ENVS[env]?.air ?? 1) * dragArea(car);
const rollN = car => 0.012 * (car.kg + DRIVER) * G;

// Estimated top speed in mph: where engine power equals air drag plus rolling drag.
export function estTop(car, env = 'dry') {
  if (!car.hp || !car.kg) return null;
  const P = car.hp * 745.7 * TUNE.effTop * (yearOf(car) < 1972 ? TUNE.gross : 1) * (1 - (POWER_LOSS[env]?.[powerKind(car)] ?? 0)), k = dragK(car, env), r = rollN(car);
  let v = 40;
  for (let i = 0; i < 40; i++) v -= (k * v ** 3 + r * v - P) / (3 * k * v * v + r); // Newton's method
  return v / MPH;
}

// Seconds to go from `from` to `to` mph, or to cover `dist` metres. null if the car can't get there.
function accel(car, env, from = 0, to = Infinity, dist = Infinity) {
  const kind = powerKind(car), m = car.kg + DRIVER, mu = grip(car) * ENVS[env].mu;
  const P = car.hp * 745.7 * TUNE.eff[kind] * (car.drive === 'AWD' ? TUNE.awd : 1) * (yearOf(car) < 1972 ? TUNE.gross : 1) * (1 - (POWER_LOSS[env]?.[kind] ?? 0));
  // share of the weight on the driven wheels as the car squats: more for rear drive, less for front drive
  const driven = car.drive === 'AWD' ? 1 : car.drive === 'RWD' ? 0.5 + 0.12 * mu : 0.62 - 0.07 * mu;
  const tyres = mu * m * G * driven, k = dragK(car, env), r = rollN(car), vLow = kind === 'electric' ? TUNE.vEv : TUNE.v1;
  const shift = kind === 'electric' || /cvt/i.test(car.box) ? 0 : /auto|dsg|dct|tronic/i.test(car.box) ? TUNE.shiftAuto : TUNE.shiftManual;
  const dt = 0.02, end = to * MPH;
  let v = from * MPH, x = 0, t = from ? 0 : TUNE.t0, coast = 0, gear = SHIFT_AT.findIndex(s => s > v);
  while (v < end && x < dist) {
    // during a gear change nothing drives the car: it coasts, still covering ground
    const push = coast > 0 ? 0 : Math.min(tyres, P / Math.max(v, vLow)), a = (push - k * v * v - r) / m;
    if ((coast <= 0 && a <= 0.02) || t > 150) return null; // run out of power before getting there
    coast -= dt;
    const nv = Math.max(0, v + a * dt), step = nv > end ? (end - v) / (nv - v) : 1; // finish part-way through the last step
    x += (v + nv) / 2 * dt * step; t += dt * step; v = nv;
    if (gear >= 0 && gear < SHIFT_AT.length && v < end && v >= SHIFT_AT[gear]) { coast = shift; gear++; }
  }
  return t;
}

function dryTime(car, ev) {
  const w = car.kg / car.hp; // kg per hp
  const tyre = grip(car) ** -0.3; // corners are part of a lap, so grip counts for less than on a skid pad
  return ev === 'lap' ? (60 + 36 * (w / 5) ** 0.45 + Math.max(0, car.kg - 1300) / 250) * tyre
    : (300 + 180 * (w / 5) ** 0.6 + Math.max(0, car.kg - 1300) / 60) * tyre;
}

// Returns seconds, or null when the car lacks the data (or the top speed) to take part.
export function raceTime(car, ev, env) {
  const e = EVENTS[ev], c = ENVS[env];
  if (!car.hp || !car.kg || !e || !c) return null;
  if (ev === 'brake') return 60 * MPH / (grip(car) * c.mu * G) * (car.brakeK ?? 1);
  if (ev === 'lap' || ev === 'hill') {
    const hpPerTonne = car.hp / car.kg * 1000;
    const spin = 1 + c.grip * (TRACTION[car.drive] ?? 0.04) * hpPerTonne / 100 * e.launch;
    const loss = POWER_LOSS[env]?.[powerKind(car)] ?? 0;
    return dryTime(car, ev) * c.base * spin * (1 / (1 - loss)) ** e.power * (car.cornerK ?? 1);
  }
  // a known top speed below the target means the car can't finish. a car with a tested 0-60 time obviously got there
  const tested = ev === 'z60' && car.z60;
  if (e.to && car.top != null && car.top < e.to * (e.to >= 100 ? 1.05 : 1) && !tested) return null; // needs a little in hand to get to 100
  const t = accel(car, env, e.from, e.to, e.dist);
  if (t == null) return tested ? car.z60 * c.base / c.mu ** 0.3 * (car.launchK ?? 1) : null; // too weak for the model: scale the tested time
  const chassis = e.from ? 1 : car.launchK ?? 1; // tyres only help off the line
  const model = car.z60 ? accel(car, 'dry', 0, 60) : null;
  if (!model) return t * chassis;
  // a tested 0-60 time anchors the model. the 0-60 race shows it exactly in the dry and moves it by the model's wet / snow /
  // altitude effect otherwise. the other events are corrected by how far out the model was, in proportion to how much of the
  // run is the sprint to 60: all of a slow quarter mile, about a third of a fast one, half for a rolling start.
  if (ev === 'z60') return car.z60 * (env === 'dry' ? 1 : t / model) * chassis;
  // when 60 mph is close to flat out, the last few mph take ages and the 0-60 time says little about the rest of the run
  const headroom = Math.min(1, Math.max(0, (estTop(car) - 60) / 40));
  const fix = Math.min(1.6, Math.max(0.6, car.z60 / model)) ** headroom;
  return t * fix ** (e.from ? 0.5 : Math.min(1, model / t)) * chassis;
}

/* ---------- modifications ---------- */
// typical gains for the engine type, not measured on any one car. gain = [power x, torque x] by engine kind:
// tp turbo petrol, td turbo diesel, na non-turbo. no entry for a kind = that part doesn't apply (e.g. remapping an EV).
// costs are rough uk prices fitted, in pounds.
export const MODS = {
  stage1:      { label: 'Stage 1 remap', group: 'tune', cost: 400, gain: { tp: [1.22, 1.28], td: [1.25, 1.3], na: [1.07, 1.06] } },
  stage2:      { label: 'Stage 2 remap', group: 'tune', cost: 650, gain: { tp: [1.27, 1.32], td: [1.28, 1.33] }, needs: ['intake', 'exhaust', 'intercooler'] },
  intake:      { label: 'Induction kit', cost: 250, gain: { tp: [1.02, 1.02], td: [1.02, 1.02], na: [1.02, 1.01] } },
  exhaust:     { label: 'Cat-back exhaust', cost: 700, gain: { tp: [1.03, 1.02], td: [1.02, 1.02], na: [1.03, 1.02] } },
  intercooler: { label: 'Bigger intercooler', cost: 500, gain: { tp: [1.03, 1.03], td: [1.03, 1.03] } },
  strip:       { label: 'Strip out (rear seats, spare wheel, trim)', cost: 0, kg: -60 },
  wheels:      { label: 'Lightweight wheels', cost: 1200, kg: -20 },
  tyres:       { label: 'Performance tyres', cost: 600, launch: 0.98, corner: 0.97, brake: 0.94 },
  suspension:  { label: 'Coilovers, 30 mm lower', cost: 900, corner: 0.98, drop: 30 },
  brakes:      { label: 'Big brake kit', cost: 1500, corner: 0.99, brake: 0.98 },
};
const engineKind = car => car.fuel === 'Electric' || car.asp === 'electric' ? 'ev' : car.asp !== 'turbo' ? 'na' : car.fuel === 'Diesel' ? 'td' : 'tp';
export const modsFor = car => Object.keys(MODS).filter(id => !MODS[id].gain || MODS[id].gain[engineKind(car)]);

// The mods that really apply to this car, in catalogue order. Unknown ids are dropped; stage 2 replaces stage 1 and brings its parts.
export function modList(car, ids) {
  const want = new Set(Array.isArray(ids) ? ids : []);
  if (want.has('stage2') && modsFor(car).includes('stage2')) { want.delete('stage1'); MODS.stage2.needs.forEach(n => want.add(n)); }
  return modsFor(car).filter(id => want.has(id));
}

const dynoOk = v => Number.isFinite(v) && v >= 1 && v <= 5000;
// Returns the car with its figures changed by the mods. dyno = { hp, nm } are the owner's own measured figures and win over the estimates.
export function applyMods(car, ids, dyno = {}) {
  const list = modList(car, ids), kind = engineKind(car);
  const own = { hp: dynoOk(dyno?.hp) ? Math.round(dyno.hp) : null, nm: dynoOk(dyno?.nm) ? Math.round(dyno.nm) : null };
  if (!list.length && !own.hp && !own.nm) return car;
  let fh = 1, fn = 1, dkg = 0, launchK = 1, cornerK = 1, brakeK = 1, drop = 0, modCost = 0;
  for (const id of list) {
    const m = MODS[id], [h, n] = m.gain?.[kind] ?? [1, 1];
    fh *= h; fn *= n; dkg += m.kg ?? 0; launchK *= m.launch ?? 1; cornerK *= m.corner ?? 1; brakeK *= m.brake ?? 1; drop += m.drop ?? 0; modCost += m.cost;
  }
  const hp = own.hp ?? (car.hp ? Math.round(car.hp * fh) : car.hp), nm = own.nm ?? (car.nm ? Math.round(car.nm * fn) : car.nm);
  const kg = car.kg ? car.kg + dkg : car.kg;
  const both = car.hp && car.kg; // need both to scale the standard times
  // the tested 0-60 moves by as much as the physics model says the changes are worth. cars too weak for the model
  // fall back to power-to-weight, less than one-for-one because traction limits the launch
  const before = both && car.z60 ? accel(car, 'dry', 0, 60) : null, after = before ? accel({ ...car, hp, kg }, 'dry', 0, 60) : null;
  const z60 = !car.z60 || !both ? car.z60
    : Math.round(car.z60 * (after ? after / before : ((kg / hp) / (car.kg / car.hp)) ** 0.8) * 10) / 10;
  const top = car.top && car.hp ? Math.round(car.top * (hp / car.hp) ** (1 / 3)) : car.top; // drag rises with speed cubed
  const changed = { hp: hp !== car.hp && !own.hp, nm: nm !== car.nm && !own.nm, kg: kg !== car.kg, z60: z60 !== car.z60, top: top !== car.top };
  const est = [...new Set([...(car.est || '').split(','), ...Object.keys(changed).filter(k => changed[k])])].filter(Boolean).join(',');
  return { ...car, hp, nm, kg, z60, top, est, launchK, cornerK, brakeK, modCost, mods: list,
    dims: car.dims && drop ? { ...car.dims, height: car.dims.height - drop } : car.dims };
}

/* ---------- running costs, clean air zones, fitting in a space ---------- */
// pence per litre / per kWh. only starting values: the app lets you type your own.
export const COST_DEFAULTS = { miles: 8000, petrol: 140, diesel: 148, elec: 27 };
const LITRES_PER_GALLON = 4.546, KWH_PER_MPGE = 40.47; // 33.7 kWh per US gallon x 1.201 UK/US gallons

// { fuel, tax, total } in pounds a year; null where the car lacks the data. Plug-in hybrids are skipped: their mpg assumes a full battery.
export function yearlyCost(car, s = COST_DEFAULTS, now = new Date()) {
  const tax = ukTax(car, now).annual;
  let fuel = null;
  if (car.fuel === 'Electric') {
    const kwhPerMile = car.batt && car.range ? car.batt / car.range : car.mpg ? KWH_PER_MPGE / car.mpg : null;
    if (kwhPerMile) fuel = s.miles * kwhPerMile * s.elec / 100;
  } else if (car.fuel !== 'Plug-in hybrid' && car.mpg) {
    fuel = s.miles / car.mpg * LITRES_PER_GALLON * (car.fuel === 'Diesel' ? s.diesel : s.petrol) / 100;
  }
  fuel = fuel == null ? null : Math.round(fuel);
  return { fuel, tax, total: fuel != null && tax != null ? fuel + tax : null };
}

// Rule of thumb for London's ULEZ and similar zones: petrol needs Euro 4 (new cars from 2006), diesel Euro 6 (from late 2015).
// Returns { ok: true | false | null (depends on the year), note }, or null when we can't tell.
export function ulez(car, now = new Date()) {
  const { year, fuel } = car;
  if (!year || !fuel) return null;
  if (fuel === 'Electric') return { ok: true, note: 'Zero emission' };
  if (ukTax({ year }, now).annual === 0) return { ok: true, note: 'Historic vehicle (over 40 years old): exempt' };
  const [from, std] = fuel === 'Diesel' ? [2016, 'Euro 6 diesel'] : [2006, 'Euro 4 petrol'];
  const last = car.years ? car.years[1] ?? 9999 : year;
  if (year >= from) return { ok: true, note: `${std} was required by then` };
  if (last >= from) return { ok: null, note: `Only cars registered from ${from} (${std})` };
  return { ok: false, note: `Built before ${std} was required (${from})` };
}

// Will the car go through a door / into a space? Sizes in mm. Widths in car data leave out the mirrors, so under 250 mm spare is "tight".
export function fits(dims, space) {
  if (!dims || !space) return null;
  const gaps = { width: space.width - dims.width, height: space.height - dims.height };
  if (space.length) gaps.length = space.length - dims.length;
  const [worst, gap] = Object.entries(gaps).sort((a, b) => a[1] - b[1])[0];
  return { ok: gap >= 0, tight: gap >= 0 && gaps.width < 250, worst, gap, gaps };
}

/* ---------- Outlines (to scale, mm) ---------- */
// Side profiles: [x along length from the front, y up from the ground] as fractions of length / height.
const PROFILES = {
  sedan:    [[0, .2], [.01, .5], [.27, .6], [.4, .97], [.67, .98], [.82, .64], [.99, .6], [1, .2]],
  coupe:    [[0, .2], [.01, .48], [.32, .58], [.45, .97], [.65, .98], [.86, .62], [.99, .58], [1, .2]],
  hatch:    [[0, .2], [.01, .5], [.25, .6], [.4, .97], [.84, .97], [.97, .82], [1, .58], [1, .2]],
  suv:      [[0, .22], [.01, .58], [.22, .66], [.33, .98], [.88, .99], [.98, .9], [1, .62], [1, .22]],
  roadster: [[0, .2], [.01, .5], [.36, .62], [.47, .95], [.5, .7], [.97, .68], [1, .6], [1, .2]],
};
const pts = a => a.map(p => p.map(n => Math.round(n)).join(',')).join(' ');
// corner radii for each profile point, as a fraction of the car's height (0 keeps the corner sharp, e.g. on the ground)
const RADII = {
  sedan: [0, .14, .05, .2, .22, .05, .1, 0], coupe: [0, .14, .05, .22, .24, .05, .1, 0], hatch: [0, .14, .05, .2, .14, .1, .08, 0],
  suv: [0, .12, .05, .16, .14, .1, .08, 0], roadster: [0, .14, .04, .03, .03, .06, .1, 0],
};
const radiiOf = body => RADII[body] || RADII.sedan;

// each corner as [cut-in point, corner, cut-out point]; a radius is capped at 45% of either edge so curves never cross
function corners(poly, radii) {
  const n = poly.length;
  return poly.map((v, i) => {
    const a = poly[(i + n - 1) % n], b = poly[(i + 1) % n], r = radii[i] || 0;
    const la = Math.hypot(a[0] - v[0], a[1] - v[1]), lb = Math.hypot(b[0] - v[0], b[1] - v[1]);
    const d = Math.min(r, la * 0.45, lb * 0.45);
    const to = (t, l) => l && d ? [v[0] + (t[0] - v[0]) * d / l, v[1] + (t[1] - v[1]) * d / l] : v;
    return [to(a, la), v, to(b, lb)];
  });
}
// smooth closed SVG path through a polygon, with rounded corners (quadratic curves)
const xy = ([x, y]) => `${Math.round(x)},${Math.round(y)}`;
export const roundedPath = (poly, radii) =>
  'M' + corners(poly, radii).map(([p, v, q], i) => `${i ? 'L' : ''}${xy(p)}Q${xy(v)} ${xy(q)}`).join('') + 'Z';
// the same curve sampled into points, for the 3D model
function roundedPts(poly, radii, steps = 5) {
  return corners(poly, radii).flatMap(([p, v, q]) => p === v && v === q ? [v]
    : Array.from({ length: steps + 1 }, (_, k) => { const t = k / steps, u = 1 - t;
      return [u * u * p[0] + 2 * u * t * v[0] + t * t * q[0], u * u * p[1] + 2 * u * t * v[1] + t * t * q[1]]; }));
}

// Returns { w, h, shapes: [{tag, attrs}] } for one view of one car, in millimetres.
export function outline(car, view) {
  const { length: L, width: W, height: H, wheelbase: WB } = car.dims;
  const wheel = Math.min(780, Math.max(560, H * 0.45)), r = wheel / 2, clear = H * 0.12;
  if (view === 'side') {
    const front = (L - WB) * 0.5, prof = PROFILES[car.body] || PROFILES.sedan;
    return { w: L, h: H, shapes: [
      { tag: 'path', d: roundedPath(prof.map(([x, y]) => [x * L, H - y * H]), radiiOf(car.body).map(k => k * H)) },
      { tag: 'circle', cx: Math.round(front), cy: Math.round(H - r), r: Math.round(r) },
      { tag: 'circle', cx: Math.round(front + WB), cy: Math.round(H - r), r: Math.round(r) },
    ] };
  }
  if (view === 'front' || view === 'rear') {
    const top = (car.body === 'roadster' ? 0.35 : 0) * H, glass = W * 0.14, tyre = W * 0.11;
    const shapes = [
      { tag: 'path', d: roundedPath([[0, H - clear], [W * 0.02, H * 0.45], [glass, top + H * 0.08], [W - glass, top + H * 0.08], [W * 0.98, H * 0.45], [W, H - clear]],
        [W * 0.03, W * 0.08, W * 0.1, W * 0.1, W * 0.08, W * 0.03]) },
      { tag: 'line', x1: Math.round(W * 0.03), y1: Math.round(H * 0.45), x2: Math.round(W * 0.97), y2: Math.round(H * 0.45) },
      { tag: 'rect', x: Math.round(W * 0.06), y: Math.round(H - wheel * 0.55), width: Math.round(tyre), height: Math.round(wheel * 0.55) },
      { tag: 'rect', x: Math.round(W * 0.94 - tyre), y: Math.round(H - wheel * 0.55), width: Math.round(tyre), height: Math.round(wheel * 0.55) },
    ];
    // headlights at the front, a full-width light bar at the back
    if (view === 'front') shapes.push(
      { tag: 'rect', x: Math.round(W * 0.07), y: Math.round(H * 0.5), width: Math.round(W * 0.18), height: Math.round(H * 0.08) },
      { tag: 'rect', x: Math.round(W * 0.75), y: Math.round(H * 0.5), width: Math.round(W * 0.18), height: Math.round(H * 0.08) });
    else shapes.push({ tag: 'rect', x: Math.round(W * 0.08), y: Math.round(H * 0.5), width: Math.round(W * 0.84), height: Math.round(H * 0.06) });
    return { w: W, h: H, shapes };
  }
  // top view: car points left
  const cabin = PROFILES[car.body] || PROFILES.sedan, x1 = cabin[3][0] * L, x2 = cabin[4][0] * L;
  return { w: L, h: W, shapes: [
    { tag: 'rect', x: 0, y: 0, width: Math.round(L), height: Math.round(W), rx: Math.round(W * 0.12) },
    { tag: 'rect', x: Math.round(x1), y: Math.round(W * 0.12), width: Math.round(Math.max(1, x2 - x1)), height: Math.round(W * 0.76), rx: Math.round(W * 0.06) },
  ] };
}

/* ---------- Catalogue helpers ---------- */
// Flatten the catalogue into one entry per trim, merging model-level fields.
export function flatten(models) {
  return models.flatMap(m => m.trims.map(t => ({
    ...m, ...t, trims: undefined, id: `${m.id}:${t.id}`, modelId: m.id, trim: t.name, year: t.year ?? m.years[0],
    tank: t.tank ?? m.tank, source: 'catalogue',
  })));
}

export const unique = arr => [...new Set(arr)].sort((a, b) => String(a).localeCompare(String(b)));

export function configPrice(car, colourName, addonNames) {
  const colour = car.colours?.find(c => c.name === colourName);
  const addons = (car.addons || []).filter(a => addonNames.includes(a.name));
  return (car.price || 0) + (colour?.price || 0) + addons.reduce((s, a) => s + a.price, 0);
}

/* ---------- typical colours by era (for cars without an official paint list) ---------- */
const ERA_COLOURS = [
  [1949, [['Black', '#141414'], ['Maroon', '#5a1a1f'], ['Brewster Green', '#1f3b2c'], ['Navy', '#1d2a44'], ['Cream', '#e9e0c8']]],
  [1959, [['Black', '#141414'], ['Ivory', '#ece4cf'], ['Turquoise', '#5fb7b0'], ['Pale Yellow', '#eedc8c'], ['Coral Red', '#c9493f'], ['Sky Blue', '#8fb3cf']]],
  [1969, [['White', '#efefea'], ['Signal Red', '#b3201f'], ['British Racing Green', '#1d3b2a'], ['Silver Blue', '#8ea3b8'], ['Beige', '#d6c7a6'], ['Black', '#141414']]],
  [1979, [['Harvest Gold', '#d4a72c'], ['Avocado Green', '#6b7a33'], ['Burnt Orange', '#c2571f'], ['Chocolate Brown', '#4a2f22'], ['White', '#efefea'], ['Bright Yellow', '#f0c419']]],
  [1989, [['White', '#f0f0ec'], ['Red', '#b4161c'], ['Silver', '#b8bcbf'], ['Black', '#141414'], ['Metallic Blue', '#2b4c7e'], ['Champagne', '#d8c8a4']]],
  [1999, [['Dark Green Metallic', '#1f3d2e'], ['Teal', '#1f6b6b'], ['Burgundy', '#5e1a24'], ['White', '#f0f0ec'], ['Silver', '#b8bcbf'], ['Black', '#141414']]],
  [2009, [['Silver', '#b8bcbf'], ['Black', '#141414'], ['Graphite Grey', '#4d5257'], ['Deep Blue', '#1d2e57'], ['Red', '#a8161f'], ['White', '#f2f2ef']]],
  [Infinity, [['Pearl White', '#f2f2f0'], ['Black', '#121212'], ['Matte Grey', '#6d7071'], ['Silver', '#b8bcbf'], ['Deep Blue', '#1f3566'], ['Racing Red', '#b0141c']]],
];
export const eraColours = year => ERA_COLOURS.find(([upTo]) => (year || 2020) <= upTo)[1].map(([name, hex]) => ({ name, hex, price: 0 }));

// typical sizes, so a car without dimensions still gets a correctly shaped icon
const BODY_DIMS = {
  sedan: { length: 4700, width: 1820, height: 1450, wheelbase: 2800 }, coupe: { length: 4500, width: 1820, height: 1350, wheelbase: 2650 },
  hatch: { length: 4250, width: 1780, height: 1460, wheelbase: 2620 }, suv: { length: 4700, width: 1900, height: 1700, wheelbase: 2850 },
  roadster: { length: 4100, width: 1750, height: 1260, wheelbase: 2400 },
};
export const iconOutline = car => outline(sized(car), 'side');

/* ---------- looks: 3D model, detailed side drawing, person and garage door ---------- */
export const sized = car => ({ ...car, dims: car.dims || BODY_DIMS[car.body] || BODY_DIMS.sedan });
const wheelOf = H => Math.min(780, Math.max(560, H * 0.45)) / 2; // same wheel size as the outlines

// Extrude a side-view polygon (profile order: clockwise with y up) between z = near and z = far.
// near/far may be per-vertex arrays, so the glasshouse can lean in. Faces wind outwards for back-face culling.
function extrude(poly, near, far, kind, caps = kind) {
  const at = (v, i) => Array.isArray(v) ? v[i] : v;
  const n = poly.map(([x, y], i) => [x, y, at(near, i)]), f = poly.map(([x, y], i) => [x, y, at(far, i)]);
  const faces = [{ pts: [...n].reverse(), kind: caps }, { pts: f, kind: caps }];
  poly.forEach((_, i) => {
    const j = (i + 1) % poly.length;
    faces.push({ pts: [n[i], n[j], f[j], f[i]], kind: typeof kind === 'function' ? kind(i) : kind });
  });
  return faces;
}
const disc = (cx, cy, r, steps = 18) => Array.from({ length: steps }, (_, i) => {
  const a = -i / steps * 2 * Math.PI; // clockwise with y up, like the profiles
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
});

// A low-poly 3D body in mm: x from the front bumper (0) to the back (L), y up from the ground, z across (±W/2).
// ponytail: one generic shape per body style, scaled to the real length/width/height/wheelbase, not the actual car.
export function carMesh(car) {
  const { dims: { length: L, width: W, height: H, wheelbase: WB }, body } = sized(car);
  const prof = (PROFILES[body] || PROFILES.sedan).map(([x, y]) => [x * L, y * H]), rad = radiiOf(body).map(k => k * H);
  const hw = W / 2, r = wheelOf(H), front = (L - WB) / 2, roadster = body === 'roadster';
  // the lower body keeps sharp corners on the ground and where the glass meets it, so the two pieces line up
  const lowerAt = [0, 1, 2, 5, 6, 7], glassAt = roadster ? [2, 3, 4] : [2, 3, 4, 5];
  const lower = roundedPts(lowerAt.map(i => prof[i]), lowerAt.map(i => i === 2 || i === 5 ? 0 : rad[i]));
  const glass = roundedPts(glassAt.map(i => prof[i]), glassAt.map((i, k) => k === 0 || k === glassAt.length - 1 ? 0 : rad[i]));
  // the glasshouse narrows smoothly towards the roof (tumblehome), starting just inside the rolled-in shoulder (0.93)
  const belt = Math.min(...glass.map(p => p[1])), roof = Math.max(...glass.map(p => p[1]));
  const lean = glass.map(([, y]) => hw * (0.92 - (roadster ? 0.04 : 0.17) * Math.min(1, Math.max(0, (y - belt) / (roof - belt || 1)))));
  const top = belt + (roof - belt) * 0.82; // edges above this are the painted roof
  // the lower body rolls in at the shoulder and the sill, so it reads as a rounded body rather than a slab
  const yTop = Math.max(...lower.map(p => p[1])), side = lower.map(([, y]) => {
    const shoulder = Math.min(1, Math.max(0, (y - (yTop - H * 0.14)) / (H * 0.14))), sill = Math.min(1, Math.max(0, (H * 0.3 - y) / (H * 0.1)));
    return hw * (1 - 0.07 * shoulder ** 2 - 0.035 * sill);
  });
  const faces = [
    ...extrude(lower, side, side.map(v => -v), 'paint'),
    ...extrude(glass, lean, lean.map(v => -v), i => {
      const a = glass[i], b = glass[(i + 1) % glass.length];
      return !roadster && Math.min(a[1], b[1]) > top ? 'paint' : 'glass';
    }, 'glass'),
  ];
  const tyre = W * 0.11, out = hw + 5;
  for (const cx of [front, front + WB]) for (const side of [1, -1]) {
    const [a, b] = side > 0 ? [out, out - tyre] : [-(out - tyre), -out];
    faces.push(...extrude(disc(cx, r, r, 24), a, b, 'tyre'));
    const rim = disc(cx, r, r * 0.66, 24).map(([x, y]) => [x, y, side * (out + 2)]);
    faces.push({ pts: side > 0 ? rim.reverse() : rim, kind: 'rim' });
  }
  // lights sit just proud of the bumpers: x = -3 faces forwards, x = L + 3 faces back
  for (const z of [hw * 0.62, -hw * 0.62]) {
    const z0 = z - hw * 0.22, z1 = z + hw * 0.22, y0 = H * 0.38, y1 = H * 0.46;
    faces.push({ pts: [[-3, y0, z0], [-3, y0, z1], [-3, y1, z1], [-3, y1, z0]], kind: 'light' });
    faces.push({ pts: [[L + 3, y0, z1], [L + 3, y0, z0], [L + 3, y1 + H * 0.04, z0], [L + 3, y1 + H * 0.04, z1]], kind: 'tail' });
  }
  return faces;
}

// Detailed side view in mm (faces left), same frame as outline(car, 'side'). Shapes carry a class for styling.
// Order matters: body, its shading and details, then the wheel wells cut in, then the wheels on top.
export function sideDetail(car) {
  const { dims: { length: L, height: H, wheelbase: WB }, body } = sized(car);
  const prof = PROFILES[body] || PROFILES.sedan, P = ([x, y]) => [x * L, H - y * H];
  const roadster = body === 'roadster', twoDoor = roadster || body === 'coupe', r = wheelOf(H), front = (L - WB) / 2;
  const [b2, b3, b4, b5] = prof.slice(2, 6);
  const win = roadster ? [[b2[0] + .03, b2[1] + .03], [b3[0] + .005, b3[1] - .05], [b4[0] - .005, b4[1] - .02]]
    : [[b2[0] + .025, b2[1] + .03], [b3[0] + .015, b3[1] - .07], [b4[0] - .015, b4[1] - .07], [b5[0] - .03, b5[1] + .03]];
  const R = Math.round, line = (cls, [x1, y1], [x2, y2]) => ({ tag: 'line', class: cls, x1: R(x1), y1: R(y1), x2: R(x2), y2: R(y2) });
  const belt = Math.min(b2[1], b5[1]) - .02, sill = .27; // door tops and bottoms, as fractions of the height
  const shapes = [
    { tag: 'ellipse', class: 'shadow', cx: R(L / 2), cy: R(H), rx: R(L * .54), ry: R(H * .05) },
    { tag: 'path', class: 'body', d: roundedPath(prof.map(P), radiiOf(body).map(k => k * H)) },
    // a darker band along the bottom and a crease along the flank give the body some shape
    { tag: 'rect', class: 'sill', x: R(front + r), y: R(H - sill * H), width: R(Math.max(1, WB - 2 * r)), height: R(H * .06), rx: R(H * .02) },
    line('crease', P([.05, .47]), P([.95, .5])),
    { tag: 'path', class: 'glass', d: roundedPath(win.map(P), win.map((_, i) => (i === 0 || i === win.length - 1 ? .02 : .07) * H)) },
  ];
  // door shut lines and a handle on each door
  const pillarX = roadster ? null : (win[0][0] + win[3][0]) / 2, doors = [win[0][0] + .01];
  if (pillarX != null) doors.push(pillarX);
  if (!twoDoor && pillarX != null) doors.push(win[3][0] - .01);
  for (const x of doors) shapes.push(line('seam', P([x, belt]), P([x, sill + .02])));
  for (const x of doors.slice(0, twoDoor ? 1 : 2)) shapes.push({ tag: 'rect', class: 'handle', x: R((x + .05) * L), y: R(H - (belt - .05) * H), width: R(L * .045), height: R(H * .025), rx: R(H * .012) });
  if (pillarX != null) { // B-pillar halfway along the side windows
    const [x1, y1] = P([(win[0][0] + win[3][0]) / 2, (win[0][1] + win[3][1]) / 2]), [x2, y2] = P([(win[1][0] + win[2][0]) / 2, (win[1][1] + win[2][1]) / 2]);
    shapes.push(line('pillar', [x1, y1], [x2, y2]));
  }
  const [mx, my] = P([win[0][0] - .005, win[0][1] + .07]);
  shapes.push(
    { tag: 'rect', class: 'mirror', x: R(mx), y: R(my), width: R(L * .04), height: R(H * .06), rx: R(H * .025) },
    { tag: 'rect', class: 'light', x: R(L * .004), y: R(H * .44), width: R(L * .055), height: R(H * .06), rx: R(H * .025) },
    { tag: 'rect', class: 'tail', x: R(L * .952), y: R(H * .44), width: R(L * .044), height: R(H * .07), rx: R(H * .025) });
  for (const cx of [front, front + WB]) {
    const cy = H - r, ring = (cls, k) => ({ tag: 'circle', class: cls, cx: R(cx), cy: R(cy), r: R(r * k) });
    shapes.push(ring('arch', 1.1), ring('tyre', 1), ring('rim', .66), ring('disc', .44));
    for (let k = 0; k < 5; k++) { // five spokes
      const a = k / 5 * 2 * Math.PI - Math.PI / 2;
      shapes.push(line('spoke', [cx + Math.cos(a) * r * .14, cy + Math.sin(a) * r * .14], [cx + Math.cos(a) * r * .6, cy + Math.sin(a) * r * .6]));
    }
    shapes.push(ring('hub', .16));
  }
  return { w: L, h: H, shapes };
}

// A 1.75 m person (roughly the UK adult average), standing, in mm, feet on y = 1750.
export const PERSON = { w: 520, h: 1750, shapes: [
  { tag: 'circle', class: 'person', cx: 260, cy: 120, r: 115 },
  { tag: 'polygon', class: 'person', points: pts([[130, 270], [390, 270], [470, 330], [500, 900], [430, 910], [400, 470], [385, 960],
    [370, 1750], [280, 1750], [260, 1050], [240, 1750], [150, 1750], [135, 960], [120, 470], [90, 910], [20, 900], [50, 330]]) },
] };
// UK standard single up-and-over garage door: 7 ft wide by 6 ft 6 in high.
export const GARAGE_DOOR = { width: 2134, height: 1981 };
