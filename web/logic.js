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
  if (year <= now.getFullYear() - 41) // historic vehicle: built 40+ years before the start of the tax year
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
  return t * c.base * spin * (1 / (1 - loss)) ** e.power;
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
