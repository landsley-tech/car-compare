// Car Compare. Copyright (c) 2026 Landsley Bowerman. MIT licence, see LICENSE.
// Designed by Landsley Bowerman; code written by Claude (Anthropic) from Landsley's prompts.
// SPDX-License-Identifier: MIT
import { esc, ukTax, raceTime, EVENTS, ENVS, outline, eraColours, flatten, unique, configPrice,
  carMesh, sideDetail, sized, PERSON, GARAGE_DOOR, MODS, modsFor, modList, applyMods, yearlyCost, COST_DEFAULTS, ulez, fits } from './logic.js';

const $ = id => document.getElementById(id);
const MAX_PICKS = 6;
const DASH = '—';

/* ---------- formatting ---------- */
const fmt = (v, unit = '', dp = 0) => v == null || Number.isNaN(v) ? DASH
  : Number(v).toLocaleString('en-GB', { maximumFractionDigits: dp, minimumFractionDigits: dp }) + unit;
const gbp = v => v == null ? DASH : '£' + Math.round(v).toLocaleString('en-GB');
const secs = s => s >= 60 ? `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}` : s.toFixed(2);
const decade = y => y ? `${Math.floor(y / 10) * 10}s` : 'Year unknown';
const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
const icon = d => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

// Fields the server estimated rather than read from a published spec (see tools/build_db.py and match_db in server.py).
const MATCHED = ['hp', 'nm', 'kg', 'z60', 'top', 'tank', 'clearance', 'cargo', 'dims'];
function isEst(car, field) {
  const est = (car.est || '').split(',');
  return est.includes(field) || (est.includes('matched') && MATCHED.includes(field));
}
const approx = (car, field, text) => text !== DASH && isEst(car, field) ? '≈' + text : text;

/* ---------- theme ---------- */
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: just don't remember */ } },
};
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  $('theme').setAttribute('aria-label', `Switch to ${t === 'dark' ? 'light' : 'dark'} theme`);
}
setTheme(store.get('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('theme').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(t);
  store.set('theme', t);
});

/* ---------- units and the numbers you type in ---------- */
let metric = store.get('units') === 'metric';
// [uk unit, metric unit, uk -> metric, decimals in metric]
const UNITS = { power: [' hp', ' kW', v => v * 0.7457], p2w: [' hp/t', ' kW/t', v => v * 0.7457], speed: [' mph', ' km/h', v => v * 1.609344],
  dist: [' miles', ' km', v => v * 1.609344], econ: [' mpg', ' L/100 km', v => 282.481 / v, 1] };
const inUnits = (kind, v) => { const [uk, m, conv, dp = 0] = UNITS[kind]; return metric ? fmt(v == null ? v : conv(v), m, dp) : fmt(v, uk); };
function setUnits(m) {
  metric = m;
  $('units').textContent = m ? 'Units: metric' : 'Units: UK';
}

// fuel prices and garage size are kept in this browser. anything missing, tampered with or out of range falls back to the default.
function loadNums(key, defaults, max) {
  let saved = null;
  try { saved = JSON.parse(store.get(key)); } catch { /* not json: use the defaults */ }
  return Object.fromEntries(Object.entries(defaults).map(([k, d]) => [k, Number.isFinite(saved?.[k]) && saved[k] >= 0 && saved[k] <= max ? saved[k] : d]));
}
const costs = loadNums('costs', COST_DEFAULTS, 100000);
const space = loadNums('space', { ...GARAGE_DOOR, length: 0 }, 20000); // mm. length 0 = don't check it

/* ---------- data ---------- */
const cache = {};
function api(path) {
  cache[path] ??= fetch('/api/' + path).then(async r => {
    if (r.ok) return r.json();
    delete cache[path];
    throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  });
  return cache[path];
}

let FEATURED = [], meta = null, src = 'db', picks = [], cfgKey = null;
let replacing = null; // the line-up pick that the finder will replace, or null when adding
const sel = {};

const onSaleIn = (c, d) => c.years[0] <= d + 9 && (c.years[1] ?? 9999) >= d; // same rule as the server's decade filter
const featuredPool = s => FEATURED.filter(c => (!s.fuel || c.fuel === s.fuel) && (!s.decade || onSaleIn(c, parseInt(s.decade))));
const featuredDecades = () => unique(FEATURED.flatMap(c => {
  const out = [];
  for (let d = Math.floor(c.years[0] / 10) * 10; d <= (c.years[1] ?? new Date().getFullYear()); d += 10) out.push(`${d}s`);
  return out;
}));
const epaOptions = s => api('epa/options?' + qs({ year: s.year, make: s.make, model: s.model }));
const yearSpan = (from, to) => `${from ?? '?'}${to === from ? '' : '–' + (to ?? 'now')}`;

// Each source lists its dropdowns in order. A field's options can depend on the choices above it.
const SOURCES = {
  db: {
    hint: () => meta ? `${fmt(meta.versions)} versions, ${meta.from}–today.` : '',
    fields: [
      { k: 'fuel', label: 'Fuel', any: 'Any fuel', opts: async () => meta.fuels },
      { k: 'decade', label: 'Era', any: 'Any year', opts: async () => meta.decades.map(d => ({ value: String(d), text: d + 's' })) },
      { k: 'make', label: 'Brand', any: 'Brand', opts: s => api('db/brands?' + qs({ fuel: s.fuel, decade: s.decade })) },
      { k: 'model', label: 'Model', any: 'Model', needs: 'make', opts: async s =>
        (await api('db/models?' + qs({ brand: s.make, fuel: s.fuel, decade: s.decade })))
          .map(m => ({ value: String(m.id), text: `${m.name} (${yearSpan(m.from, m.to)})`, group: decade(m.from) })) },
      { k: 'version', label: 'Version', any: 'Version', needs: 'model', opts: async s =>
        (await api('db/versions?' + qs({ model: s.model, fuel: s.fuel })))
          .map(v => ({ value: String(v.id), text: `${v.text} · ${v.fuel}` })) },
    ],
    load: s => api('db/car?' + qs({ id: s.version })),
  },
  featured: {
    hint: () => 'Curated cars with factory colours, options and launch prices, including British classics.',
    fields: [
      { k: 'fuel', label: 'Fuel', any: 'Any fuel', opts: async () => unique(FEATURED.map(c => c.fuel)) },
      { k: 'decade', label: 'Era', any: 'Any year', opts: async () => featuredDecades() },
      { k: 'make', label: 'Brand', any: 'Brand', opts: async s => unique(featuredPool(s).map(c => c.make)) },
      { k: 'model', label: 'Model', any: 'Model', needs: 'make', opts: async s => [...new Map(featuredPool(s)
        .filter(c => c.make === s.make)
        .map(c => [c.modelId, { value: c.modelId, text: `${c.model} (${c.gen}, ${yearSpan(...c.years)})` }])).values()] },
      { k: 'version', label: 'Version', any: 'Version', needs: 'model', opts: async s => featuredPool(s)
        .filter(c => c.modelId === s.model).map(c => ({ value: c.id, text: `${c.trim} · ${c.fuel}` })) },
    ],
    load: async s => FEATURED.find(c => c.id === s.version),
  },
  epa: {
    hint: () => 'Every US-market car since 1984, live from the EPA. Power and size come from the closest database match.',
    fields: [
      { k: 'year', label: 'Year', any: 'Year', opts: () => api('epa/years') },
      { k: 'make', label: 'Brand', any: 'Brand', needs: 'year', opts: s => api('epa/makes?' + qs({ year: s.year })) },
      { k: 'model', label: 'Model', any: 'Model', needs: 'make', opts: s => api('epa/models?' + qs({ year: s.year, make: s.make })) },
      { k: 'fuel', label: 'Fuel', any: 'Any fuel', needs: 'model', opts: async s => unique((await epaOptions(s)).map(o => o.fuel)) },
      { k: 'version', label: 'Version', any: 'Version', needs: 'model', opts: async s => (await epaOptions(s))
        .filter(o => !s.fuel || o.fuel === s.fuel).map(o => ({ value: String(o.id), text: `${o.text} · ${o.fuel}` })) },
    ],
    load: s => api('epa/vehicle?' + qs({ id: s.version })),
  },
};

/* ---------- finder ---------- */
function selectHtml(f, opts) {
  const list = opts.map(o => typeof o === 'object' ? o : { value: String(o), text: String(o) });
  const option = o => `<option value="${esc(o.value)}" ${o.value === sel[f.k] ? 'selected' : ''}>${esc(o.text)}</option>`;
  const groups = list.some(o => o.group) ? unique(list.map(o => o.group)) : null;
  const body = groups
    ? groups.map(g => `<optgroup label="${esc(g)}">${list.filter(o => o.group === g).map(option).join('')}</optgroup>`).join('')
    : list.map(option).join('');
  const placeholder = f.needs && !sel[f.needs] ? DASH : f.any + (list.length > 1 ? ` (${fmt(list.length)})` : '');
  return `<label class="field"><span>${esc(f.label)}</span>
    <select id="f-${f.k}" data-k="${f.k}" ${list.length ? '' : 'disabled'}><option value="">${esc(placeholder)}</option>${body}</select></label>`;
}

let renderSeq = 0;
async function renderFinder() {
  const seq = ++renderSeq;
  setStatus('loading', 'Loading…');
  $('add').disabled = true;
  try {
    let html = '';
    for (const f of SOURCES[src].fields) {
      const opts = f.needs && !sel[f.needs] ? [] : await f.opts(sel);
      if (seq !== renderSeq) return; // a newer change has started its own render
      const values = opts.map(o => typeof o === 'object' ? o.value : String(o));
      if (!values.includes(sel[f.k])) sel[f.k] = f.k === 'version' && values.length === 1 ? values[0] : '';
      html += selectHtml(f, opts);
    }
    $('fields').innerHTML = html;
    updateAddButton();
    setStatus();
  } catch (e) {
    if (seq === renderSeq) setStatus('error', `Couldn't load the list: ${e.message}`);
  }
}

function setStatus(kind, text = '') {
  $('status').className = 'status' + (kind === 'error' ? ' error' : '');
  $('status').innerHTML = (kind === 'loading' ? '<span class="spinner" aria-hidden="true"></span>' : '') + esc(text);
}
function updateAddButton() {
  $('add').disabled = !sel.version || (picks.length >= MAX_PICKS && !replacing);
  $('add-label').textContent = replacing ? `Replace ${replacing.car.model}` : 'Add to comparison';
  $('cancel-replace').hidden = !replacing;
}

function setSource(s, preset = {}) {
  src = s;
  Object.keys(sel).forEach(k => delete sel[k]);
  Object.assign(sel, preset);
  document.querySelectorAll('.tabs [role=tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.src === s));
  $('src-hint').textContent = SOURCES[s].hint();
  renderFinder();
}

/* ---------- line-up ---------- */
// p.stock is the standard car; p.car is what the rest of the page shows: the same car with p.mods applied.
function retune(p) {
  p.mods = modList(p.stock, p.mods);
  p.car = applyMods(p.stock, p.mods, p.dyno);
}

function addCar(car, mods = []) {
  if (!car) return false;
  if (picks.length >= MAX_PICKS) { setStatus('error', `Up to ${MAX_PICKS} cars.`); return false; }
  if (picks.some(p => p.car.id === car.id)) { setStatus('error', 'Already in your line-up.'); return false; }
  const used = picks.map(p => p.series);
  const series = [1, 2, 3, 4, 5, 6].find(n => !used.includes(n));
  const p = { stock: car, series, colour: colours(car)[0].name, addons: [], mods, dyno: {} };
  retune(p);
  picks.push(p);
  cfgKey = car.id;
  return true;
}

// Swap the car in one line-up slot, keeping its place and colour slot. Paint and options carry over where the new car has them.
function replacePick(p, car) {
  if (!car) return false;
  if (picks.some(x => x !== p && x.car.id === car.id)) { setStatus('error', 'Already in your line-up.'); return false; }
  p.stock = car;
  p.dyno = {}; // dyno figures belonged to the old car; the mods carry over where they still apply
  retune(p);
  if (!colours(car).some(c => c.name === p.colour)) p.colour = colours(car)[0].name;
  p.addons = p.addons.filter(a => car.addons?.some(x => x.name === a));
  cfgKey = car.id;
  return true;
}

// The other versions of the same model, as [{ id, text }], for the swap dropdown on each line-up card.
async function siblings(car) {
  if (car.source === 'db' && car.modelId) return (await api('db/versions?' + qs({ model: car.modelId })))
    .map(v => ({ id: 'db-' + v.id, text: `${v.text} · ${v.fuel}` }));
  if (car.source === 'catalogue') return FEATURED.filter(c => c.modelId === car.modelId).map(c => ({ id: c.id, text: `${c.trim} · ${c.fuel}` }));
  if (car.source === 'epa') return (await epaOptions({ year: car.year, make: car.make, model: car.model }))
    .map(o => ({ id: 'epa-' + o.id, text: `${o.text} · ${o.fuel}` }));
  return [];
}

// "Change": load this car into the finder so a different brand, model or version can replace it.
function startReplace(p) {
  replacing = p;
  const c = p.car;
  if (c.source === 'db') setSource('db', { make: c.make, model: String(c.modelId ?? ''), version: c.id.slice(3) });
  else if (c.source === 'epa') setSource('epa', { year: String(c.year), make: c.make, model: c.model, version: c.id.slice(4) });
  else setSource('featured', { make: c.make, model: c.modelId, version: c.id });
  $('finder').scrollIntoView();
  $('f-make')?.focus({ preventScroll: true });
}
function stopReplace() { replacing = null; updateAddButton(); }

async function addSelected(load = () => SOURCES[src].load(sel)) {
  $('add').disabled = true;
  setStatus('loading', 'Adding…');
  try {
    const car = await load();
    const was = replacing?.car;
    if (replacing ? replacePick(replacing, car) : addCar(car)) {
      replacing = null;
      setStatus('', was ? `Replaced the ${was.model} with the ${car.make} ${car.model}.` : `Added ${car.make} ${car.model}.`);
      renderAll();
    }
  } catch (e) {
    setStatus('error', `Couldn't load that car: ${e.message}`);
  }
  updateAddButton();
}

function loadCar(id) {
  if (/^db-\d{1,8}$/.test(id)) return api('db/car?' + qs({ id: id.slice(3) }));
  if (/^epa-\d{1,8}$/.test(id)) return api('epa/vehicle?' + qs({ id: id.slice(4) }));
  return Promise.resolve(FEATURED.find(c => c.id === id));
}

// Share links look like #cars=db-3497~stage1.exhaust,epa-38623,bmw-m4-f82:m4  (~ starts a car's mods)
function saveHash() {
  const ids = picks.map(p => p.car.id + (p.mods.length ? '~' + p.mods.join('.') : '')).join(',');
  history.replaceState(null, '', ids ? '#cars=' + encodeURIComponent(ids) : location.pathname);
}
let restoreRun = 0;
async function restoreHash() {
  const run = ++restoreRun;
  const m = location.hash.match(/^#cars=([^&]{1,400})$/);
  if (!m) return;
  let ids;
  try { ids = decodeURIComponent(m[1]).split(',').slice(0, MAX_PICKS); } catch { return; } // malformed link: ignore it
  const items = ids.map(t => t.split('~'));
  const cars = await Promise.all(items.map(([id]) => loadCar(id).catch(() => null)));
  if (run !== restoreRun) return; // another link was opened meanwhile
  cars.forEach((car, i) => addCar(car, (items[i][1] || '').split('.'))); // unknown mod names are dropped by modList
  setStatus();
  renderAll();
}

/* ---------- shared bits ---------- */
const name = c => `${c.make} ${c.model}`;
const col = p => `var(--s${p.series})`;
const colours = car => car.colours || eraColours(car.year);
const paint = p => colours(p.car).find(c => c.name === p.colour)?.hex ?? col(p);
const price = p => p.car.price ? configPrice(p.car, p.colour, p.addons) : null;
const yearsText = c => c.years ? yearSpan(...c.years) : c.year;
const svgShape = s => `<${s.tag} ${Object.entries(s).filter(([k]) => k !== 'tag').map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}/>`;

// Detailed side-on drawing (faces left) in a given paint, for cards without a photo and the race lanes.
// The paint is a validated #hex from the colour list or one of our own var(--sN) names, and is escaped anyway.
function carArt(car, paintColour) {
  const o = sideDetail(car), pad = Math.round(o.h * 0.08);
  return `<svg class="art" viewBox="${-pad} ${-pad} ${o.w + pad * 2} ${o.h + pad * 2}" aria-hidden="true" style="--paint:${esc(paintColour)}">${o.shapes.map(svgShape).join('')}</svg>`;
}

/* ---------- tray ---------- */
function renderTray() {
  const slots = picks.map(p => `<article class="slot" style="--c:${col(p)}">
    <div class="photo">${p.car.image
      ? `<img src="${esc(p.car.image)}" alt="${esc(name(p.car))}" loading="lazy" referrerpolicy="no-referrer" width="320" height="180">`
      : carArt(p.car, paint(p))}</div>
    <div class="meta">
      <span class="make">${esc(p.car.make)}</span>
      <span class="model">${esc(p.car.model)}</span>
      <span class="sub" title="${esc(p.car.trim)}">${esc(p.car.trim)} · ${esc(yearsText(p.car))}${p.car !== p.stock ? ' · modified' : ''}</span>
    </div>
    <div class="actions">
      <select class="ver" data-swap="${p.series}" aria-label="Version of the ${esc(name(p.car))}" hidden></select>
      <button class="btn small-btn ${replacing === p ? 'on' : ''}" type="button" data-change="${p.series}">Change</button>
    </div>
    <button class="remove" type="button" data-remove="${esc(p.car.id)}" aria-label="Remove ${esc(name(p.car))}">${icon('M18 6 6 18M6 6l12 12')}</button>
  </article>`);
  if (picks.length < MAX_PICKS) slots.push(`<button class="slot add" type="button" id="add-slot">+ Add a car</button>`);
  $('tray').innerHTML = slots.join('');
  // a broken or blocked photo falls back to the drawing
  $('tray').querySelectorAll('img').forEach(img => img.addEventListener('error', () => {
    const p = picks.find(x => x.car.image === img.getAttribute('src'));
    if (p) img.parentElement.innerHTML = carArt(p.car, paint(p));
  }, { once: true }));
  // fill each card's version dropdown once its list arrives (cached, so re-renders are instant)
  for (const p of picks) siblings(p.car).then(list => {
    const s = $('tray').querySelector(`[data-swap="${p.series}"]`);
    if (!s || list.length < 2 || !list.some(v => v.id === p.car.id)) return;
    s.innerHTML = list.map(v => `<option value="${esc(v.id)}" ${v.id === p.car.id ? 'selected' : ''}>${esc(v.text)}</option>`).join('');
    s.hidden = false;
  }).catch(() => { /* no list (offline, EPA down): the card just has no dropdown */ });
  $('tray-count').textContent = `${picks.length} / ${MAX_PICKS}`;
  $('share').disabled = !picks.length;
  $('clear').disabled = !picks.length;
  $('save').disabled = !picks.length;
}

/* ---------- search ---------- */
let searchSeq = 0, searchTimer = 0;
const searchWords = q => q.toLowerCase().replace(/[^\w .,&()'/+-]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 6); // only what the server accepts
async function search() {
  const w = searchWords($('q').value), seq = ++searchSeq;
  if (w.join('').length < 2) { $('hits').innerHTML = ''; return; }
  const featured = FEATURED.filter(c => w.every(x => `${c.make} ${c.model} ${c.gen} ${c.trim}`.toLowerCase().includes(x))).slice(0, 8)
    .map(c => ({ id: c.id, text: `${c.make} ${c.model} · ${c.trim}`, fuel: c.fuel, years: yearSpan(...c.years), tag: ' · Featured' }));
  let found = [], note = 'No cars match.';
  if (meta) {
    try {
      found = (await api('db/search?' + qs({ q: w.join(' ') }))).map(h => ({ ...h, id: 'db-' + h.id, years: yearSpan(h.from, h.to), tag: '' }));
    } catch (e) { note = `Couldn't search the full database: ${e.message}`; }
  }
  if (seq !== searchSeq) return; // a newer keystroke has its own search running
  $('hits').innerHTML = [...featured, ...found].map(h => `<li><button type="button" data-hit="${esc(h.id)}">${esc(h.text)}
    <span class="muted small">${esc(h.years)} · ${esc(h.fuel ?? '')}${h.tag}</span></button></li>`).join('') || `<li class="muted small">${esc(note)}</li>`;
}

/* ---------- saved line-ups (kept in this browser only) ---------- */
const HASH_RE = /^#cars=[^&]{1,400}$/;
function savedList() {
  try {
    const list = JSON.parse(store.get('lineups'));
    return Array.isArray(list) ? list.filter(x => typeof x?.name === 'string' && HASH_RE.test(x?.hash)).slice(0, 20) : [];
  } catch { return []; }
}
function renderSaved() {
  $('saved').innerHTML = savedList().map((x, i) => `<span class="chip"><button type="button" data-load="${i}">${esc(x.name.slice(0, 80))}</button>
    <button type="button" data-forget="${i}" aria-label="Delete saved line-up ${esc(x.name.slice(0, 80))}">${icon('M18 6 6 18M6 6l12 12')}</button></span>`).join('');
}

/* ---------- overview ---------- */
const hpPerTonne = c => c.hp && c.kg ? Math.round(c.hp / c.kg * 1000) : null;
const METRICS = [
  { title: 'Power', key: 'hp', get: c => c.hp, u: 'power', best: 'max' },
  { title: 'Torque', key: 'nm', get: c => c.nm, unit: ' Nm', best: 'max' },
  { title: 'Weight', key: 'kg', get: c => c.kg, unit: ' kg', best: 'min' },
  { title: 'Power-to-weight', key: 'kg', get: hpPerTonne, u: 'p2w', best: 'max' },
  { title: '0–60 mph', key: 'z60', get: c => c.z60, unit: ' s', best: 'min', dp: 1 },
  { title: 'Economy', key: 'mpg', get: c => ['Electric', 'Plug-in hybrid'].includes(c.fuel) ? null : c.mpg, u: 'econ', best: 'max' },
  { title: 'Price new', key: 'price', get: (c, p) => price(p), best: 'min', money: true },
  { title: 'Fuel and tax a year', key: 'cost', get: (c, p) => cost(c, p).total, best: 'min', money: true },
];

function renderMetrics() {
  $('metrics').innerHTML = METRICS.filter(m => picks.some(p => m.get(p.car, p) != null)).map(m => {
    const vals = picks.map(p => m.get(p.car, p)).filter(v => v != null);
    const max = Math.max(...vals);
    const best = m.best === 'max' ? max : Math.min(...vals);
    const rows = picks.map(p => {
      const v = m.get(p.car, p);
      const text = v == null ? DASH : approx(p.car, m.key, m.money ? gbp(v) : m.u ? inUnits(m.u, v) : fmt(v, m.unit, m.dp));
      const isBest = v != null && vals.length > 1 && v === best;
      return `<div class="bar-row" style="--c:${col(p)}"><span title="${esc(name(p.car))}">${esc(p.car.model)}</span>
        <span class="bar">${v == null ? '' : `<i style="--w:${(v / max * 100).toFixed(1)}%"></i>`}</span>
        <span class="v ${isBest ? 'best' : ''}">${text}</span></div>`;
    }).join('');
    const hint = m.best === 'min' ? ' <span class="muted small">lower is better</span>'
      : m.u === 'econ' && metric ? ' <span class="muted small">longer bar uses less fuel</span>' : '';
    return `<div class="metric"><h3>${m.title}${hint}</h3>${rows}</div>`;
  }).join('');
}

/* ---------- dimensions ---------- */
const VIEWS = [['side', 'Side'], ['front', 'Front'], ['rear', 'Rear'], ['top', 'Top']];

function viewSvg(view, label, sized) {
  const outs = sized.map(p => ({ p, o: outline(p.car, view) }));
  const door = view === 'front' ? space : null;
  const W = Math.max(...outs.map(x => x.o.w), door?.width ?? 0), H = Math.max(...outs.map(x => x.o.h), door?.height ?? 0), pad = W * 0.04;
  const shapes = outs.map(({ p, o }) => {
    // side and top line up at the front; front and rear are centred; everything stands on the same ground
    const dx = view === 'side' || view === 'top' ? 0 : (W - o.w) / 2;
    const dy = view === 'top' ? (H - o.h) / 2 : H - o.h;
    return `<g class="shape" transform="translate(${dx.toFixed(0)} ${dy.toFixed(0)})" stroke="${col(p)}" fill="${esc(paint(p))}">
      ${o.shapes.map(svgShape).join('')}</g>`;
  }).join('');
  const ground = view === 'top' ? '' : `<line class="ground" x1="${-pad}" y1="${H}" x2="${W + pad}" y2="${H}"/>`;
  const doorSvg = door ? `<rect class="door" x="${(W - door.width) / 2}" y="${H - door.height}" width="${door.width}" height="${door.height}"/>` : '';
  const legend = sized.map(p => `<span><span class="dot" style="--c:${col(p)}"></span>${esc(p.car.model)}</span>`).join('')
    + (door ? `<span><span class="door-key"></span>${door.width === GARAGE_DOOR.width && door.height === GARAGE_DOOR.height
      ? 'UK single garage door' : 'Your space'}, ${metres(door.width)} × ${metres(door.height)} m</span>` : '');
  return `<figure class="view ${view === 'side' || view === 'top' ? 'wide' : ''}"><h3>${label}</h3>
    <svg viewBox="${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}" role="img" aria-label="${label} view">${ground}${doorSvg}${shapes}</svg>
    <div class="legend">${legend}</div></figure>`;
}

const TOO = { width: 'wide', height: 'tall', length: 'long' };
function fitCell(dims) {
  const f = fits(dims, space);
  if (!f.ok) return `<span class="bad">No: ${fmt(-f.gap)} mm too ${TOO[f.worst]}</span>`;
  return `${f.tight ? 'Tight' : 'Yes'}: ${fmt(f.gaps.width / 2)} mm each side, ${fmt(f.gaps.height)} mm above`
    + (f.gaps.length != null ? `, ${fmt(f.gaps.length)} mm to spare in length` : '')
    + (f.tight ? '<br><span class="muted small">Car widths leave out the mirrors (about 200 mm more)</span>' : '');
}

function renderViews() {
  const sized = picks.filter(p => p.car.dims);
  const missing = picks.filter(p => !p.car.dims).map(p => esc(name(p.car)));
  $('views').innerHTML = (sized.length ? VIEWS.map(([v, label]) => viewSvg(v, label, sized)).join('') : '')
    + (missing.length ? `<p class="muted small">No size data: ${missing.join(', ')}.</p>` : '');

  const ref = sized[0]?.car.dims;
  const rows = [['Length', 'length'], ['Width', 'width'], ['Height', 'height'], ['Wheelbase', 'wheelbase']].map(([label, k]) =>
    `<tr><th scope="row">${label}</th>${sized.map((p, i) => {
      const d = p.car.dims[k] - ref[k];
      const diff = i && d ? ` <span class="diff">${d > 0 ? '+' : ''}${fmt(d)}</span>` : '';
      return `<td>${approx(p.car, 'dims', fmt(p.car.dims[k], ' mm'))}${diff}</td>`;
    }).join('')}</tr>`).join('')
    + `<tr><th scope="row">Fits your space</th>${sized.map(p => `<td>${fitCell(p.car.dims)}</td>`).join('')}</tr>`;
  $('dims-table').innerHTML = sized.length
    ? `<thead><tr><th></th>${sized.map(p => `<th style="--c:${col(p)}">${esc(name(p.car))}</th>`).join('')}</tr></thead><tbody>${rows}</tbody>` : '';
  $('dims-table').parentElement.hidden = !sized.length;
}

/* ---------- looks: 3D models and side drawings ---------- */
const metres = mm => (mm / 1000).toFixed(2);
const sizeText = c => c.dims ? `${metres(c.dims.length)} × ${metres(c.dims.width)} × ${metres(c.dims.height)} m` : 'No size data: typical size shown';

function renderLooks() {
  $('models').innerHTML = picks.map(p => `<figure class="model3d" style="--c:${col(p)}">
    <canvas data-series="${p.series}" tabindex="0" role="img" aria-label="3D model of the ${esc(name(p.car))} in ${esc(p.colour)}. Arrow keys turn it."></canvas>
    <figcaption><b>${esc(name(p.car))}</b><span class="muted small">${esc(sizeText(p.car))}</span></figcaption></figure>`).join('');
  meshes = Object.fromEntries(picks.map(p => [p.series, carMesh(p.car)]));
  reach = Math.max(...picks.map(p => { const d = sized(p.car).dims; return Math.hypot(d.length, d.width); }));
  draw3d();

  // side drawings share one frame, so they are all to the same scale
  const cars = picks.map(p => ({ p, o: sideDetail(p.car) })), gap = 400;
  const W = PERSON.w + gap + Math.max(...cars.map(x => x.o.w)), H = Math.max(PERSON.h, ...cars.map(x => x.o.h)), pad = 60;
  const person = `<g transform="translate(0 ${H - PERSON.h})">${PERSON.shapes.map(svgShape).join('')}</g>`;
  $('profiles').innerHTML = cars.map(({ p, o }) => `<figure class="profile">
    <svg viewBox="${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}" role="img" aria-label="${esc(name(p.car))} side on, next to a 1.75 m person">
      <line class="ground" x1="${-pad}" y1="${H}" x2="${W + pad}" y2="${H}"/>${person}
      <g class="art" transform="translate(${PERSON.w + gap} ${H - o.h})" style="--paint:${esc(paint(p))}">${o.shapes.map(svgShape).join('')}</g></svg>
    <figcaption><span class="dot" style="--c:${col(p)}"></span>${esc(name(p.car))} <span class="muted small">${esc(p.car.trim)} · ${esc(p.colour)}</span></figcaption></figure>`).join('');
}

// A tiny painter's-algorithm renderer: cull faces pointing away, sort the rest back to front, shade by one light.
let meshes = {}, reach = 1, yaw = -0.6, spinning = !matchMedia('(prefers-reduced-motion: reduce)').matches, spinRaf = 0;
const PITCH = 0.32, LIGHT = [-0.35, 0.8, 0.5].map(v => v / Math.hypot(-0.35, 0.8, 0.5));
const FIXED = { glass: '#1d2833', tyre: '#151515', rim: '#b9bfc5', light: '#f4f1dc', tail: '#b3121b' };
// Blinn-Phong highlight: half-way between the light and the viewer (who looks down -z, so faces we see have z > 0)
const HALF = (h => h.map(v => v / Math.hypot(...h)))([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);
const GLOSS = { paint: [0.55, 28], glass: [0.85, 60], rim: [0.45, 16], light: [0.3, 10], tail: [0.3, 10] };
const rgb = hex => /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) : [136, 136, 136];

function draw3d() {
  for (const cv of $('models').querySelectorAll('canvas')) {
    const p = picks.find(x => x.series === +cv.dataset.series), faces = meshes[p?.series];
    if (!faces) continue;
    const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const L = sized(p.car).dims.length, s = w * 0.98 / reach, cy = h * 0.66;
    const cos = Math.cos(yaw), sin = Math.sin(yaw), cp = Math.cos(PITCH), sp = Math.sin(PITCH);
    const view = ([x, y, z]) => {
      x -= L / 2;
      const x1 = x * cos - z * sin, z1 = x * sin + z * cos;
      return [x1, y * cp - z1 * sp, y * sp + z1 * cp];
    };
    const paintRgb = rgb(paint(p));
    const drawn = [];
    for (const f of faces) {
      const v = f.pts.map(view);
      let nx = 0, ny = 0, nz = 0; // Newell normal: robust for the slightly bent glasshouse faces
      v.forEach((a, i) => { const b = v[(i + 1) % v.length]; nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]); });
      if (nz <= 0) continue;
      const n = Math.hypot(nx, ny, nz), lit = 0.42 + 0.58 * Math.max(0, (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) / n);
      const [gk, ge] = GLOSS[f.kind] || [0, 1], spec = gk * Math.max(0, (nx * HALF[0] + ny * HALF[1] + nz * HALF[2]) / n) ** ge;
      const base = f.kind === 'paint' ? paintRgb : rgb(FIXED[f.kind]);
      drawn.push({ v, depth: v.reduce((t, a) => t + a[2], 0) / v.length,
        fill: `rgb(${base.map(c => Math.min(255, Math.round(c * lit + 255 * spec))).join(' ')})` });
    }
    // soft shadow on the ground first, then faces from the back forwards
    const W2 = sized(p.car).dims.width / 2 + 60, [gx, gy] = view([L / 2, 0, 0]), gr = L * 0.62 * s;
    const soft = ctx.createRadialGradient(0, 0, 0, 0, 0, gr);
    soft.addColorStop(0, 'rgb(0 0 0 / .28)'); soft.addColorStop(1, 'rgb(0 0 0 / 0)');
    ctx.save(); ctx.translate(w / 2 + gx * s, cy - gy * s); ctx.scale(1, 0.32);
    ctx.fillStyle = soft; ctx.beginPath(); ctx.arc(0, 0, gr, 0, 2 * Math.PI); ctx.fill(); ctx.restore();
    ctx.fillStyle = 'rgb(0 0 0 / .14)';
    ctx.beginPath();
    [[-60, 0, W2], [L + 60, 0, W2], [L + 60, 0, -W2], [-60, 0, -W2]].map(view).forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](w / 2 + x * s, cy - y * s));
    ctx.fill();
    drawn.sort((a, b) => a.depth - b.depth);
    for (const d of drawn) {
      ctx.beginPath();
      d.v.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](w / 2 + x * s, cy - y * s));
      ctx.closePath();
      ctx.fillStyle = ctx.strokeStyle = d.fill;
      ctx.fill();
      ctx.lineWidth = 0.6;
      ctx.stroke(); // hides hairline gaps between neighbouring faces
    }
  }
}

// Slow turntable while the section is on screen; dragging or the arrow keys take over.
let looksVisible = false;
function spin(t0) {
  cancelAnimationFrame(spinRaf);
  if (!spinning || !looksVisible || !picks.length) return;
  spinRaf = requestAnimationFrame(t => { yaw += Math.min(50, t - (t0 ?? t)) / 1000 * 0.35; draw3d(); spin(t); });
}
new IntersectionObserver(([e]) => { looksVisible = e.isIntersecting; spin(); }).observe($('models'));
let drag = null;
$('models').addEventListener('pointerdown', e => {
  if (e.target.tagName !== 'CANVAS') return;
  drag = { x: e.clientX, yaw };
  spinning = false;
  e.target.setPointerCapture(e.pointerId);
});
$('models').addEventListener('pointermove', e => {
  if (!drag) return;
  yaw = drag.yaw + (e.clientX - drag.x) / 120;
  draw3d();
});
addEventListener('pointerup', () => { drag = null; });
$('models').addEventListener('keydown', e => {
  if (e.target.tagName !== 'CANVAS' || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  e.preventDefault();
  spinning = false;
  yaw += e.key === 'ArrowLeft' ? -0.26 : 0.26; // 15°
  draw3d();
});
addEventListener('resize', draw3d);

/* ---------- race ---------- */
let raf = 0;
const raceTimes = () => picks.map(p => ({ p, t: raceTime(p.car, $('event').value, $('env').value) }));
const finishTimes = () => raceTimes().map(x => x.t).filter(t => t != null);

function renderRace() {
  const ev = EVENTS[$('event').value], env = $('env').value;
  $('board').className = `card board ${env}`;
  $('race-name').textContent = `${ev.label} · ${ENVS[env].label}`;
  $('race-note').textContent = `${ev.note}. ${ENVS[env].note}.`;
  $('strip').innerHTML = raceTimes().map(({ p, t }) => {
    const lane = t != null
      ? `<div class="car" id="car-${p.series}" style="--c:${col(p)}">${carArt(p.car, col(p))}<span class="tag" id="tag-${p.series}"></span></div>`
      : `<span class="dnf">${p.car.hp && p.car.kg ? (EVENTS[$('event').value].to ? `Can't reach ${EVENTS[$('event').value].to} mph` : "Can't finish") : 'No power or weight data'}</span>`;
    return `<div class="lane"><div class="lane-label" title="${esc(name(p.car))}">${esc(p.car.model)}<small>${esc(p.car.year ?? '')}</small></div>
      <div class="track">${lane}</div></div>`;
  }).join('');
  rest();
}

function showResults(t) {
  const done = raceTimes().filter(x => x.t != null).sort((a, b) => a.t - b.t), best = done[0]?.t;
  $('race-results').innerHTML = done.map(({ p, t: rt }, i) => {
    const finished = rt <= t;
    const dist = EVENTS[$('event').value].metres; // braking is judged on stopping distance
    const gap = !finished ? '' : i ? (dist ? `+${(dist(rt) - dist(best)).toFixed(1)} m` : `+${(rt - best).toFixed(2)} s`) : done.length > 1 ? 'Winner' : 'Solo run';
    return `<div class="res ${finished ? '' : 'pending'}" style="--c:${col(p)}">
      <div class="pos">P${i + 1}</div><div class="name">${esc(p.car.model)}</div>
      <div>${!finished ? DASH : dist ? `${dist(rt).toFixed(1)} m <span class="muted small">in ${secs(rt)} s</span>` : secs(rt) + ' s'}</div><div class="gap">${gap}</div></div>`;
  }).join('');
}

function place(t) {
  const { k, metres } = EVENTS[$('event').value];
  raceTimes().forEach(({ p, t: rt }) => {
    if (rt == null) return;
    const progress = Math.min(1, (t / rt) ** k);
    $('car-' + p.series).style.setProperty('--p', progress);
    $('tag-' + p.series).textContent = progress < 1 ? '' : metres ? metres(rt).toFixed(1) + ' m' : secs(rt);
  });
  $('clock').textContent = secs(t);
}

const setGo = label => { $('go').querySelector('span').textContent = label; };

// Resting frame: the moment the winner crosses the line, so the gaps show without pressing Start.
function rest() {
  cancelAnimationFrame(raf);
  const done = finishTimes(), t = done.length ? Math.min(...done) : 0;
  place(t);
  showResults(t);
  setGo('Start');
}

function start() {
  cancelAnimationFrame(raf);
  const done = finishTimes();
  if (!done.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return rest();
  const last = Math.max(...done), speed = last > 16 ? last / 9 : 1; // long races play back in about 9 s
  const t0 = performance.now();
  setGo('Restart');
  const tick = now => {
    const t = Math.min(last, (now - t0) / 1000 * speed);
    place(t);
    showResults(t);
    if (t < last) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

/* ---------- modifications ---------- */
const carChooser = (id, p) => picks.length > 1 ? `<label class="field"><span>Car</span><select id="${id}">${picks.map(x =>
  `<option value="${esc(x.car.id)}" ${x === p ? 'selected' : ''}>${esc(name(x.car))} · ${esc(x.car.trim)}</option>`).join('')}</select></label>` : '';

function renderMods() {
  const p = picks.find(x => x.car.id === cfgKey) || picks[0];
  cfgKey = p.car.id;
  const avail = modsFor(p.stock), tunes = avail.filter(id => MODS[id].group === 'tune'), forced = p.mods.includes('stage2') ? MODS.stage2.needs : [];
  const cur = p.mods.find(id => MODS[id].group === 'tune') ?? '';
  const radio = (id, label, cost) => `<label class="option"><input type="radio" name="tune" value="${id}" ${id === cur ? 'checked' : ''}>
    <span>${label}</span><span class="price">${cost}</span></label>`;
  const tune = tunes.length ? radio('', 'Standard', '') + tunes.map(id => radio(id, MODS[id].label, gbp(MODS[id].cost))).join('')
      + (forced.length ? '<p class="muted small">Stage 2 needs the induction kit, exhaust and intercooler, so they are ticked for you.</p>' : '')
    : '<p class="muted small">An electric car can\'t be remapped like an engine. The parts still apply.</p>';
  const parts = avail.filter(id => !MODS[id].group).map(id => `<label class="option">
    <input type="checkbox" value="${id}" ${p.mods.includes(id) ? 'checked' : ''} ${forced.includes(id) ? 'disabled' : ''}>
    <span>${MODS[id].label}</span><span class="price">${MODS[id].cost ? gbp(MODS[id].cost) : 'Free'}</span></label>`).join('');
  const dyno = k => `<label class="field"><span>${k === 'hp' ? 'Power (hp)' : 'Torque (Nm)'}</span>
    <input type="number" min="1" max="5000" step="1" inputmode="numeric" data-dyno="${k}" value="${p.dyno[k] ?? ''}"></label>`;
  const row = (label, c) => `<tr><th scope="row">${label}</th>${[approx(c, 'hp', inUnits('power', c.hp)), approx(c, 'nm', fmt(c.nm, ' Nm')),
    approx(c, 'kg', fmt(c.kg, ' kg')), approx(c, 'z60', fmt(c.z60, ' s', 1)), approx(c, 'top', inUnits('speed', c.top))].map(v => `<td>${v}</td>`).join('')}</tr>`;
  const changed = p.car !== p.stock;
  $('mod-card').innerHTML = `${carChooser('mod-car', p)}<div class="cfg-grid">
    <fieldset><legend>Engine tune</legend>${tune}</fieldset>
    <fieldset><legend>Parts</legend>${parts}</fieldset>
    <fieldset><legend>Already modified? Enter your dyno figures</legend><div class="row end nums">${dyno('hp')}${dyno('nm')}</div>
      <p class="muted small">Your own figures replace the estimates.</p></fieldset></div>
    <div class="table-box"><table id="mod-table"><thead><tr><th></th><th>Power</th><th>Torque</th><th>Weight</th><th>0–60 mph</th><th>Top speed</th></tr></thead>
      <tbody>${row('Standard', p.stock)}${changed ? row('Modified', p.car) : ''}</tbody></table></div>
    ${p.mods.length ? `<div class="total"><span class="muted small">Parts and fitting, roughly</span><strong>${gbp(p.car.modCost)}</strong></div>` : ''}
    <p class="muted small">These are typical gains for this kind of engine, not figures measured on this car, and prices vary by car and garage.
      Tell your insurer about every modification: an undeclared one can void your cover. Mods can also affect the maker's warranty.
      Economy, CO2 and tax shown elsewhere are for the standard car.</p>`;
}

/* ---------- colours & options ---------- */
function renderCfg() {
  const p = picks.find(x => x.car.id === cfgKey) || picks[0];
  cfgKey = p.car.id;
  const c = p.car, official = !!c.colours;
  const chooser = carChooser('cfg-car', p);
  const swatches = colours(c).map((k, i) => `<label class="swatch" style="--sw:${esc(k.hex)}">
    <input type="radio" name="paint" value="${i}" ${k.name === p.colour ? 'checked' : ''}><i></i>${esc(k.name)}
    ${official ? `<span class="muted">${k.price ? '+' + gbp(k.price) : 'No cost'}</span>` : ''}</label>`).join('');
  const options = c.addons ? c.addons.map((a, i) => `<label class="option">
    <input type="checkbox" value="${i}" ${p.addons.includes(a.name) ? 'checked' : ''}>
    <span>${esc(a.name)}</span><span class="price">${a.price ? '+' + gbp(a.price) : 'No cost'}</span></label>`).join('')
    : '<p class="muted small">Factory options are listed for Featured cars only.</p>';
  const total = price(p) ? `<div class="total"><span class="muted small">As configured</span><strong>${gbp(price(p))}</strong>
    <span class="muted small">Launch list price</span></div>` : '';
  $('cfg').innerHTML = `${chooser}<div class="cfg-grid">
    <fieldset><legend>${official ? 'Factory colours' : `Typical colours of the ${decade(c.year)}`}</legend><div class="swatches">${swatches}</div></fieldset>
    <fieldset><legend>Options</legend>${options}</fieldset>${total}</div>`;
}

/* ---------- specification ---------- */
function taxCell(c, p) {
  const t = ukTax({ ...c, price: price(p) ?? c.price });
  if (t.annual == null) return DASH;
  const first = t.firstYear != null ? `<br><span class="muted small">First year ${gbp(t.firstYear)}</span>` : '';
  return `${gbp(t.annual)} a year${first}<br><span class="muted small">${esc(t.note)}</span>`;
}
const cost = (c, p) => yearlyCost({ ...c, price: price(p) ?? c.price }, costs);
function ulezCell(c) {
  const u = ulez(c);
  if (!u) return DASH;
  return `${u.ok ? 'Likely fine' : u.ok === false ? 'Likely charged' : 'Depends on the year'}<br><span class="muted small">${esc(u.note)}</span>`;
}
const range = c => c.range ? c.range
  : c.tank && c.mpg && !['Electric', 'Plug-in hybrid'].includes(c.fuel) ? Math.round(c.tank / 4.546 * c.mpg) : null;
const dim = k => c => approx(c, 'dims', fmt(c.dims?.[k], ' mm'));
const num = (k, unit, dp) => c => approx(c, k, fmt(c[k], unit, dp));

// [label, render, value for "best", 'max' | 'min']. A row whose cells are all "—" is not shown.
const SPEC = [
  ['Performance'],
  ['Power', c => approx(c, 'hp', inUnits('power', c.hp)), c => c.hp, 'max'],
  ['Torque', num('nm', ' Nm'), c => c.nm, 'max'],
  ['Power-to-weight', c => approx(c, 'kg', inUnits('p2w', hpPerTonne(c))), hpPerTonne, 'max'],
  ['0–60 mph', num('z60', ' s', 1), c => c.z60, 'min'],
  ['Top speed', c => approx(c, 'top', inUnits('speed', c.top)), c => c.top, 'max'],
  ['Engine'],
  ['Fuel', c => esc(c.fuel ?? DASH)],
  ['Engine', c => esc(c.engine ?? DASH)],
  ['Engine size', c => fmt(c.cc, ' cc')],
  ['Drive', c => esc(c.drive ?? DASH)],
  ['Gearbox', c => esc(c.box ?? DASH)],
  ['Running costs'],
  ['Economy', c => c.fuel === 'Electric' ? DASH : inUnits('econ', c.mpg), c => c.fuel === 'Electric' ? null : c.mpg, 'max'],
  ['CO2', c => fmt(c.co2, ' g/km'), c => c.co2, 'min'],
  ['UK car tax', taxCell],
  ['Fuel a year', (c, p) => gbp(cost(c, p).fuel), (c, p) => cost(c, p).fuel, 'min'],
  ['Fuel + tax a year', (c, p) => gbp(cost(c, p).total), (c, p) => cost(c, p).total, 'min'],
  ['ULEZ / clean air zones', ulezCell],
  ['Fuel tank', c => approx(c, 'tank', fmt(c.tank, ' L'))],
  ['Range', c => inUnits('dist', range(c)), range, 'max'],
  ['Battery', c => fmt(c.batt, ' kWh')],
  ['Size'],
  ['Length', dim('length')], ['Width', dim('width')], ['Height', dim('height')], ['Wheelbase', dim('wheelbase')],
  ['Ground clearance', num('clearance', ' mm')],
  ['Boot', num('cargo', ' L'), c => c.cargo, 'max'],
  ['Weight', num('kg', ' kg'), c => c.kg, 'min'],
  ['Price'],
  ['Price new', c => gbp(c.price), c => c.price, 'min'],
  ['As configured', (c, p) => gbp(price(p))],
  ['Colour', (c, p) => `<span class="dot" style="--c:${esc(paint(p))}"></span>${esc(p.colour)}`],
  ['Options', (c, p) => p.addons.length ? p.addons.map(esc).join(', ') : DASH],
  ['About'],
  ['Version', c => esc(c.trim)],
  ['Modifications', c => c.mods?.length ? c.mods.map(id => MODS[id].label).join(', ') : DASH],
  ['Mods cost', c => c.mods?.length ? gbp(c.modCost) : DASH],
  ['Built', c => esc(yearsText(c) ?? DASH)],
  ['Figures from', c => c.matched ? `Closest match: ${esc(c.matched)}`
    : ({ db: 'autoevolution', epa: 'US EPA' })[c.source] ?? 'Featured catalogue'],
];

function renderSpec() {
  const rows = [];
  let group = null;
  for (const [label, render, value, better] of SPEC) {
    if (!render) { group = label; continue; }
    const cells = picks.map(p => render(p.car, p));
    if (cells.every(c => c === DASH)) continue;
    if (group) { rows.push(`<tr class="group"><th colspan="${picks.length + 1}" scope="colgroup">${group}</th></tr>`); group = null; }
    const vals = value ? picks.map(p => value(p.car, p)) : [];
    const known = vals.filter(v => v != null);
    const best = known.length > 1 && new Set(known).size > 1 ? (better === 'max' ? Math.max(...known) : Math.min(...known)) : null;
    rows.push(`<tr><th scope="row">${label}</th>${cells.map((cell, i) =>
      `<td class="${best != null && vals[i] === best ? 'best' : ''}">${cell}</td>`).join('')}</tr>`);
  }
  const head = picks.map(p => `<th style="--c:${col(p)}" scope="col">${esc(name(p.car))}<small>${esc(p.car.trim)}</small></th>`).join('');
  $('spec-table').innerHTML = `<thead><tr><th></th>${head}</tr></thead><tbody>${rows.join('')}</tbody>`;
}

function renderAll() {
  const any = picks.length > 0;
  $('results').hidden = !any;
  $('empty').hidden = any;
  $('overview-title').textContent = picks.length === 1 ? 'Specification' : 'Overview';
  renderTray();
  saveHash();
  updateAddButton();
  if (!any) return;
  renderMetrics();
  renderViews();
  renderLooks();
  spin();
  renderRace();
  renderMods();
  renderCfg();
  renderSpec();
}

/* ---------- events ---------- */
$('fields').addEventListener('change', e => {
  if (!e.target.dataset.k) return;
  sel[e.target.dataset.k] = e.target.value;
  renderFinder(); // drops any choices below that are no longer valid
});
document.querySelector('.tabs').addEventListener('click', e => {
  const tab = e.target.closest('[role=tab]');
  if (tab) setSource(tab.dataset.src);
});
$('add').addEventListener('click', () => addSelected());
$('tray').addEventListener('click', e => {
  const id = e.target.closest('[data-remove]')?.dataset.remove;
  const change = e.target.closest('[data-change]')?.dataset.change;
  if (id) {
    if (replacing?.car.id === id) replacing = null;
    picks = picks.filter(p => p.car.id !== id);
    renderAll();
  } else if (change) {
    startReplace(picks.find(p => p.series === +change));
    renderTray();
  } else if (e.target.closest('#add-slot')) {
    $('finder').scrollIntoView();
    document.querySelector('#fields select:not(:disabled)')?.focus({ preventScroll: true });
  }
});
$('tray').addEventListener('change', async e => {
  const p = picks.find(x => x.series === +e.target.dataset.swap);
  if (!p) return;
  setStatus('loading', 'Swapping…');
  try {
    if (replacePick(p, await loadCar(e.target.value))) { setStatus(); renderAll(); } else renderTray(); // put the dropdown back
  } catch (err) {
    setStatus('error', `Couldn't load that version: ${err.message}`);
  }
});
$('cancel-replace').addEventListener('click', () => { stopReplace(); renderTray(); setStatus(); });
$('clear').addEventListener('click', () => { picks = []; replacing = null; renderAll(); });
$('share').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    setStatus('', 'Link copied.');
  } catch {
    setStatus('', 'Copy the address bar to share.');
  }
});
// A share link pasted into an open tab only changes the hash. saveHash uses replaceState, which never fires this.
// a link opened while the app is still starting waits for the catalogue and database list, instead of being dropped
// a newer link wins over one still loading, and a failed start never blocks later links
addEventListener('hashchange', () => started.catch(() => {}).then(() => { picks = []; replacing = null; return restoreHash(); }));

$('event').innerHTML = Object.entries(EVENTS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
$('env').innerHTML = Object.entries(ENVS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
$('event').addEventListener('change', renderRace);
$('env').addEventListener('change', renderRace);
$('go').addEventListener('click', start);

$('cfg').addEventListener('change', e => {
  if (e.target.id === 'cfg-car') { cfgKey = e.target.value; renderMods(); return renderCfg(); }
  const p = picks.find(x => x.car.id === cfgKey);
  if (e.target.name === 'paint') {
    p.colour = colours(p.car)[e.target.value].name;
  } else if (e.target.type === 'checkbox') {
    const addon = p.car.addons[e.target.value].name;
    p.addons = e.target.checked ? [...p.addons, addon] : p.addons.filter(x => x !== addon);
  }
  renderCfg();
  renderMetrics();
  renderViews();
  renderLooks();
  renderSpec();
});

$('mod-card').addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'mod-car') { cfgKey = t.value; renderCfg(); return renderMods(); }
  const p = picks.find(x => x.car.id === cfgKey);
  if (t.name === 'tune') p.mods = [...p.mods.filter(id => MODS[id].group !== 'tune'), ...(t.value ? [t.value] : [])];
  else if (t.type === 'checkbox') p.mods = t.checked ? [...p.mods, t.value] : p.mods.filter(id => id !== t.value);
  else if (t.dataset.dyno) p.dyno = { ...p.dyno, [t.dataset.dyno]: +t.value >= 1 && +t.value <= 5000 ? +t.value : undefined };
  retune(p);
  renderAll();
});

$('q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, 250); });
$('hits').addEventListener('click', e => {
  const id = e.target.closest('[data-hit]')?.dataset.hit;
  if (id) addSelected(() => loadCar(id));
});

$('save').addEventListener('click', () => {
  const entry = { name: picks.map(p => p.car.model).join(' vs ').slice(0, 80), hash: location.hash };
  store.set('lineups', JSON.stringify([entry, ...savedList().filter(x => x.hash !== entry.hash)].slice(0, 20)));
  renderSaved();
  setStatus('', 'Saved in this browser.');
});
$('saved').addEventListener('click', e => {
  const load = e.target.closest('[data-load]')?.dataset.load, forget = e.target.closest('[data-forget]')?.dataset.forget;
  if (load != null) location.hash = savedList()[load].hash; // hashchange below rebuilds the line-up
  else if (forget != null) { store.set('lineups', JSON.stringify(savedList().filter((x, i) => i !== +forget))); renderSaved(); }
});

$('units').addEventListener('click', () => {
  setUnits(!metric);
  store.set('units', metric ? 'metric' : 'uk');
  if (picks.length) renderAll();
});

// number boxes: a bad or out-of-range entry is put back to the last good value
function bindNums(ids, obj, key, scale, rerender) {
  for (const [id, k] of Object.entries(ids)) {
    $(id).value = obj[k] ? obj[k] / scale : k === 'miles' ? 0 : '';
    $(id).addEventListener('change', e => {
      const v = e.target.value === '' ? 0 : +e.target.value * scale;
      if (Number.isFinite(v) && v >= +e.target.min * scale && v <= +e.target.max * scale) { obj[k] = v; store.set(key, JSON.stringify(obj)); }
      else e.target.value = obj[k] ? obj[k] / scale : '';
      if (picks.length) rerender();
    });
  }
}
bindNums({ 'c-miles': 'miles', 'c-petrol': 'petrol', 'c-diesel': 'diesel', 'c-elec': 'elec' }, costs, 'costs', 1, () => { renderMetrics(); renderSpec(); });
bindNums({ 'sp-width': 'width', 'sp-height': 'height', 'sp-length': 'length' }, space, 'space', 1000, renderViews);
setUnits(metric);
renderSaved();

/* ---------- start ---------- */
const started = Promise.all([
  fetch('/data/cars.json').then(r => r.json()).then(models => { FEATURED = flatten(models); }),
  api('db/meta').then(m => { meta = m; }).catch(() => { /* no database: Featured and US register still work */ }),
]).then(async () => {
  if (meta) $('counts').textContent = `${fmt(meta.versions)} versions of ${fmt(meta.models)} models from ${meta.brands} brands, plus every US-market car since 1984.`;
  setSource(meta ? 'db' : 'featured');
  renderTray();
  await restoreHash();
});

// Installable app with an offline shell (needs https, or localhost while testing).
if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
