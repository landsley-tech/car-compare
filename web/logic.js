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
  z60:  { label: '0–60 mph', note: 'Standing start', launch: 1, power: 0.9, k: 2 },
  qm:   { label: '¼ mile', note: '402 m from a standing start', launch: 0.6, power: 0.33, k: 1.6 },
  roll: { label: '50–100 mph', note: 'Rolling start, side by side at 50 mph', launch: 0.3, power: 1.1, k: 1.3 },
  lap:  { label: 'Circuit lap', note: 'One flying lap of a 2.5 km club circuit', launch: 0.25, power: 0.3, k: 1 },
  hill: { label: 'Mountain pass', note: '8 km uphill run, hairpins and all', launch: 0.25, power: 0.5, k: 1 },
};
export const ENVS = {
  dry:      { label: 'Dry', grip: 0, base: 1, note: 'Warm, dry tarmac' },
  wet:      { label: 'Wet', grip: 1, base: 1.07, note: 'Standing water: traction decides it' },
  snow:     { label: 'Snow', grip: 3, base: 1.3, note: 'Packed snow on winter tyres' },
  altitude: { label: 'High altitude', grip: 0, base: 1, note: '2,500 m: thin air hurts non-turbo engines' },
  heat:     { label: 'Desert heat', grip: 0, base: 1.01, note: '45 °C: heat soak cuts power' },
};
const TRACTION = { RWD: 0.045, FWD: 0.035, AWD: 0.01 };
const POWER_LOSS = { altitude: { na: 0.25, turbo: 0.08, electric: 0 }, heat: { na: 0.06, turbo: 0.08, electric: 0.04 } };

function dryTime(car, ev) {
  const w = car.kg / car.hp; // kg per hp
  const launch = car.drive === 'AWD' ? 0.92 : car.drive === 'FWD' ? 1.05 : 1;
  switch (ev) {
    case 'z60': return car.z60 ?? 1.05 * w ** 0.95 * launch;
    case 'qm': return 6.1 * (w * 2.2046) ** (1 / 3) * launch ** 0.5;
    case 'roll': return car.top != null && car.top < 105 ? null : 1.35 * w ** 1.1;
    case 'lap': return 60 + 36 * (w / 5) ** 0.45 + Math.max(0, car.kg - 1300) / 250;
    case 'hill': return 300 + 180 * (w / 5) ** 0.6 + Math.max(0, car.kg - 1300) / 60;
  }
}

// Returns seconds, or null when the car lacks the data (or the top speed) to take part.
export function raceTime(car, ev, env) {
  if (!car.hp || !car.kg || !EVENTS[ev] || !ENVS[env]) return null;
  const t = dryTime(car, ev);
  if (t == null) return null;
  const e = EVENTS[ev], c = ENVS[env];
  const hpPerTonne = car.hp / car.kg * 1000;
  const spin = 1 + c.grip * (TRACTION[car.drive] ?? 0.04) * hpPerTonne / 100 * e.launch;
  const loss = POWER_LOSS[env]?.[car.asp || 'na'] ?? 0;
  const chassis = ev === 'lap' || ev === 'hill' ? car.cornerK : ev === 'roll' ? 1 : car.launchK; // set by applyMods
  return t * c.base * spin * (1 / (1 - loss)) ** e.power * (chassis ?? 1);
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
  tyres:       { label: 'Performance tyres', cost: 600, launch: 0.98, corner: 0.97 },
  suspension:  { label: 'Coilovers, 30 mm lower', cost: 900, corner: 0.98, drop: 30 },
  brakes:      { label: 'Big brake kit', cost: 1500, corner: 0.99 },
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
  let fh = 1, fn = 1, dkg = 0, launchK = 1, cornerK = 1, drop = 0, modCost = 0;
  for (const id of list) {
    const m = MODS[id], [h, n] = m.gain?.[kind] ?? [1, 1];
    fh *= h; fn *= n; dkg += m.kg ?? 0; launchK *= m.launch ?? 1; cornerK *= m.corner ?? 1; drop += m.drop ?? 0; modCost += m.cost;
  }
  const hp = own.hp ?? (car.hp ? Math.round(car.hp * fh) : car.hp), nm = own.nm ?? (car.nm ? Math.round(car.nm * fn) : car.nm);
  const kg = car.kg ? car.kg + dkg : car.kg;
  const both = car.hp && car.kg; // need both to scale the standard times
  // 0-60 follows power-to-weight less than one-for-one, because traction limits the launch
  const z60 = car.z60 && both ? Math.round(car.z60 * ((kg / hp) / (car.kg / car.hp)) ** 0.8 * 10) / 10 : car.z60;
  const top = car.top && car.hp ? Math.round(car.top * (hp / car.hp) ** (1 / 3)) : car.top; // drag rises with speed cubed
  const changed = { hp: hp !== car.hp && !own.hp, nm: nm !== car.nm && !own.nm, kg: kg !== car.kg, z60: z60 !== car.z60, top: top !== car.top };
  const est = [...new Set([...(car.est || '').split(','), ...Object.keys(changed).filter(k => changed[k])])].filter(Boolean).join(',');
  return { ...car, hp, nm, kg, z60, top, est, launchK, cornerK, modCost, mods: list,
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

// Returns { w, h, shapes: [{tag, attrs}] } for one view of one car, in millimetres.
export function outline(car, view) {
  const { length: L, width: W, height: H, wheelbase: WB } = car.dims;
  const wheel = Math.min(780, Math.max(560, H * 0.45)), r = wheel / 2, clear = H * 0.12;
  if (view === 'side') {
    const front = (L - WB) * 0.5, prof = PROFILES[car.body] || PROFILES.sedan;
    return { w: L, h: H, shapes: [
      { tag: 'polygon', points: pts(prof.map(([x, y]) => [x * L, H - y * H])) },
      { tag: 'circle', cx: Math.round(front), cy: Math.round(H - r), r: Math.round(r) },
      { tag: 'circle', cx: Math.round(front + WB), cy: Math.round(H - r), r: Math.round(r) },
    ] };
  }
  if (view === 'front' || view === 'rear') {
    const top = (car.body === 'roadster' ? 0.35 : 0) * H, glass = W * 0.14, tyre = W * 0.11;
    const shapes = [
      { tag: 'polygon', points: pts([[0, H - clear], [W * 0.02, H * 0.45], [glass, top + H * 0.08], [W - glass, top + H * 0.08], [W * 0.98, H * 0.45], [W, H - clear]]) },
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
  const prof = (PROFILES[body] || PROFILES.sedan).map(([x, y]) => [x * L, y * H]);
  const hw = W / 2, r = wheelOf(H), front = (L - WB) / 2, roadster = body === 'roadster';
  const lower = [prof[0], prof[1], prof[2], prof[5], prof[6], prof[7]];
  const glass = roadster ? prof.slice(2, 5) : prof.slice(2, 6);
  const lean = glass.map((_, i) => i === 0 || i === glass.length - 1 ? hw * 0.94 : hw * (roadster ? 0.9 : 0.76));
  const faces = [
    ...extrude(lower, hw, -hw, 'paint'),
    // side windows are glass; of the edges, only the roof is painted
    ...extrude(glass, lean, lean.map(v => -v), i => i === 1 && !roadster ? 'paint' : 'glass', 'glass'),
  ];
  const tyre = W * 0.11, out = hw + 5;
  for (const cx of [front, front + WB]) for (const side of [1, -1]) {
    const [a, b] = side > 0 ? [out, out - tyre] : [-(out - tyre), -out];
    faces.push(...extrude(disc(cx, r, r), a, b, 'tyre'));
    const rim = disc(cx, r, r * 0.62).map(([x, y]) => [x, y, side * (out + 2)]);
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
export function sideDetail(car) {
  const { dims: { length: L, height: H, wheelbase: WB }, body } = sized(car);
  const prof = PROFILES[body] || PROFILES.sedan, P = ([x, y]) => [x * L, H - y * H];
  const roadster = body === 'roadster', r = wheelOf(H), front = (L - WB) / 2;
  const [b2, b3, b4, b5] = prof.slice(2, 6);
  const win = roadster ? [[b2[0] + .03, b2[1] + .03], [b3[0] + .005, b3[1] - .05], [b4[0] - .005, b4[1] - .02]]
    : [[b2[0] + .025, b2[1] + .03], [b3[0] + .015, b3[1] - .07], [b4[0] - .015, b4[1] - .07], [b5[0] - .03, b5[1] + .03]];
  const shapes = [
    ...[front, front + WB].map(cx => ({ tag: 'circle', class: 'arch', cx: Math.round(cx), cy: Math.round(H - r), r: Math.round(r * 1.1) })),
    { tag: 'polygon', class: 'body', points: pts(prof.map(P)) },
    { tag: 'polygon', class: 'glass', points: pts(win.map(P)) },
    { tag: 'rect', class: 'light', x: Math.round(L * .004), y: Math.round(H * .44), width: Math.round(L * .05), height: Math.round(H * .06), rx: Math.round(H * .02) },
    { tag: 'rect', class: 'tail', x: Math.round(L * .955), y: Math.round(H * .44), width: Math.round(L * .04), height: Math.round(H * .07), rx: Math.round(H * .02) },
  ];
  if (!roadster) { // B-pillar halfway along the side windows
    const [x1, y1] = P([(win[0][0] + win[3][0]) / 2, (win[0][1] + win[3][1]) / 2]), [x2, y2] = P([(win[1][0] + win[2][0]) / 2, (win[1][1] + win[2][1]) / 2]);
    shapes.push({ tag: 'line', class: 'pillar', x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2) });
  }
  for (const cx of [front, front + WB]) shapes.push(
    { tag: 'circle', class: 'tyre', cx: Math.round(cx), cy: Math.round(H - r), r: Math.round(r) },
    { tag: 'circle', class: 'rim', cx: Math.round(cx), cy: Math.round(H - r), r: Math.round(r * .62) },
    { tag: 'circle', class: 'hub', cx: Math.round(cx), cy: Math.round(H - r), r: Math.round(r * .16) });
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
