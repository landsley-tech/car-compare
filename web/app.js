// Car Compare. Copyright (c) 2026 Landsley Bowerman. MIT licence, see LICENSE.
// Designed by Landsley Bowerman; code written by Claude (Anthropic) from Landsley's prompts.
// SPDX-License-Identifier: MIT
import { esc, ukTax, raceTime, EVENTS, ENVS, outline, iconOutline, eraColours, flatten, unique, configPrice } from './logic.js';

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
const updateAddButton = () => { $('add').disabled = !sel.version || picks.length >= MAX_PICKS; };

function setSource(s) {
  src = s;
  Object.keys(sel).forEach(k => delete sel[k]);
  document.querySelectorAll('.tabs [role=tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.src === s));
  $('src-hint').textContent = SOURCES[s].hint();
  renderFinder();
}

/* ---------- line-up ---------- */
function addCar(car) {
  if (!car) return false;
  if (picks.length >= MAX_PICKS) { setStatus('error', `Up to ${MAX_PICKS} cars.`); return false; }
  if (picks.some(p => p.car.id === car.id)) { setStatus('error', 'Already in your line-up.'); return false; }
  const used = picks.map(p => p.series);
  const series = [1, 2, 3, 4, 5, 6].find(n => !used.includes(n));
  picks.push({ car, series, colour: colours(car)[0].name, addons: [] });
  cfgKey = car.id;
  return true;
}

async function addSelected() {
  $('add').disabled = true;
  setStatus('loading', 'Adding…');
  try {
    const car = await SOURCES[src].load(sel);
    if (addCar(car)) { setStatus('', `Added ${car.make} ${car.model}.`); renderAll(); }
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

// Share links look like #cars=db-3497,epa-38623,bmw-m4-f82:m4
function saveHash() {
  const ids = picks.map(p => p.car.id).join(',');
  history.replaceState(null, '', ids ? '#cars=' + encodeURIComponent(ids) : location.pathname);
}
async function restoreHash() {
  const m = location.hash.match(/^#cars=([^&]{1,400})$/);
  if (!m) return;
  let ids;
  try { ids = decodeURIComponent(m[1]).split(',').slice(0, MAX_PICKS); } catch { return; } // malformed link: ignore it
  const cars = await Promise.all(ids.map(id => loadCar(id).catch(() => null)));
  cars.forEach(addCar);
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

// Side silhouette from the same outline geometry as the dimension drawings (faces left).
function silhouette(car) {
  const o = iconOutline(car);
  const body = svgShape({ ...o.shapes[0], fill: 'currentColor' });
  const wheels = o.shapes.slice(1).map(w => svgShape({ ...w, fill: '#111' })).join('');
  return `<svg viewBox="0 0 ${o.w} ${o.h}" aria-hidden="true">${body}${wheels}</svg>`;
}

/* ---------- tray ---------- */
function renderTray() {
  const slots = picks.map(p => `<article class="slot" style="--c:${col(p)}">
    <div class="photo">${p.car.image
      ? `<img src="${esc(p.car.image)}" alt="${esc(name(p.car))}" loading="lazy" referrerpolicy="no-referrer" width="320" height="180">`
      : silhouette(p.car)}</div>
    <div class="meta">
      <span class="make">${esc(p.car.make)}</span>
      <span class="model">${esc(p.car.model)}</span>
      <span class="sub" title="${esc(p.car.trim)}">${esc(p.car.trim)} · ${esc(yearsText(p.car))}</span>
    </div>
    <button class="remove" type="button" data-remove="${esc(p.car.id)}" aria-label="Remove ${esc(name(p.car))}">${icon('M18 6 6 18M6 6l12 12')}</button>
  </article>`);
  if (picks.length < MAX_PICKS) slots.push(`<button class="slot add" type="button" id="add-slot">+ Add a car</button>`);
  $('tray').innerHTML = slots.join('');
  // a broken or blocked photo falls back to the silhouette
  $('tray').querySelectorAll('img').forEach(img => img.addEventListener('error', () => {
    const p = picks.find(x => x.car.image === img.getAttribute('src'));
    if (p) img.parentElement.innerHTML = silhouette(p.car);
  }, { once: true }));
  $('tray-count').textContent = `${picks.length} / ${MAX_PICKS}`;
  $('share').disabled = !picks.length;
  $('clear').disabled = !picks.length;
}

/* ---------- overview ---------- */
const hpPerTonne = c => c.hp && c.kg ? Math.round(c.hp / c.kg * 1000) : null;
const METRICS = [
  { title: 'Power', key: 'hp', get: c => c.hp, unit: ' hp', best: 'max' },
  { title: 'Torque', key: 'nm', get: c => c.nm, unit: ' Nm', best: 'max' },
  { title: 'Weight', key: 'kg', get: c => c.kg, unit: ' kg', best: 'min' },
  { title: 'Power-to-weight', key: 'kg', get: hpPerTonne, unit: ' hp/t', best: 'max' },
  { title: '0–60 mph', key: 'z60', get: c => c.z60, unit: ' s', best: 'min', dp: 1 },
  { title: 'Economy', key: 'mpg', get: c => ['Electric', 'Plug-in hybrid'].includes(c.fuel) ? null : c.mpg, unit: ' mpg', best: 'max' },
  { title: 'Price new', key: 'price', get: (c, p) => price(p), best: 'min', money: true },
];

function renderMetrics() {
  $('metrics').innerHTML = METRICS.filter(m => picks.some(p => m.get(p.car, p) != null)).map(m => {
    const vals = picks.map(p => m.get(p.car, p)).filter(v => v != null);
    const max = Math.max(...vals);
    const best = m.best === 'max' ? max : Math.min(...vals);
    const rows = picks.map(p => {
      const v = m.get(p.car, p);
      const text = v == null ? DASH : approx(p.car, m.key, m.money ? gbp(v) : fmt(v, m.unit, m.dp));
      const isBest = v != null && vals.length > 1 && v === best;
      return `<div class="bar-row" style="--c:${col(p)}"><span title="${esc(name(p.car))}">${esc(p.car.model)}</span>
        <span class="bar">${v == null ? '' : `<i style="--w:${(v / max * 100).toFixed(1)}%"></i>`}</span>
        <span class="v ${isBest ? 'best' : ''}">${text}</span></div>`;
    }).join('');
    const hint = m.best === 'min' ? ' <span class="muted small">lower is better</span>' : '';
    return `<div class="metric"><h3>${m.title}${hint}</h3>${rows}</div>`;
  }).join('');
}

/* ---------- dimensions ---------- */
const VIEWS = [['side', 'Side'], ['front', 'Front'], ['rear', 'Rear'], ['top', 'Top']];

function viewSvg(view, label, sized) {
  const outs = sized.map(p => ({ p, o: outline(p.car, view) }));
  const W = Math.max(...outs.map(x => x.o.w)), H = Math.max(...outs.map(x => x.o.h)), pad = W * 0.04;
  const shapes = outs.map(({ p, o }) => {
    // side and top line up at the front; front and rear are centred; everything stands on the same ground
    const dx = view === 'side' || view === 'top' ? 0 : (W - o.w) / 2;
    const dy = view === 'top' ? (H - o.h) / 2 : H - o.h;
    return `<g class="shape" transform="translate(${dx.toFixed(0)} ${dy.toFixed(0)})" stroke="${col(p)}" fill="${esc(paint(p))}">
      ${o.shapes.map(svgShape).join('')}</g>`;
  }).join('');
  const ground = view === 'top' ? '' : `<line class="ground" x1="${-pad}" y1="${H}" x2="${W + pad}" y2="${H}"/>`;
  const legend = sized.map(p => `<span><span class="dot" style="--c:${col(p)}"></span>${esc(p.car.model)}</span>`).join('');
  return `<figure class="view ${view === 'side' || view === 'top' ? 'wide' : ''}"><h3>${label}</h3>
    <svg viewBox="${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}" role="img" aria-label="${label} view">${ground}${shapes}</svg>
    <div class="legend">${legend}</div></figure>`;
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
    }).join('')}</tr>`).join('');
  $('dims-table').innerHTML = sized.length
    ? `<thead><tr><th></th>${sized.map(p => `<th style="--c:${col(p)}">${esc(name(p.car))}</th>`).join('')}</tr></thead><tbody>${rows}</tbody>` : '';
  $('dims-table').parentElement.hidden = !sized.length;
}

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
      ? `<div class="car" id="car-${p.series}" style="--c:${col(p)}">${silhouette(p.car)}<span class="tag" id="tag-${p.series}"></span></div>`
      : `<span class="dnf">${p.car.hp && p.car.kg ? "Can't reach 100 mph" : 'No power or weight data'}</span>`;
    return `<div class="lane"><div class="lane-label" title="${esc(name(p.car))}">${esc(p.car.model)}<small>${esc(p.car.year ?? '')}</small></div>
      <div class="track">${lane}</div></div>`;
  }).join('');
  rest();
}

function showResults(t) {
  const done = raceTimes().filter(x => x.t != null).sort((a, b) => a.t - b.t), best = done[0]?.t;
  $('race-results').innerHTML = done.map(({ p, t: rt }, i) => {
    const finished = rt <= t;
    const gap = !finished ? '' : i ? `+${(rt - best).toFixed(2)} s` : done.length > 1 ? 'Winner' : 'Solo run';
    return `<div class="res ${finished ? '' : 'pending'}" style="--c:${col(p)}">
      <div class="pos">P${i + 1}</div><div class="name">${esc(p.car.model)}</div>
      <div>${finished ? secs(rt) + ' s' : DASH}</div><div class="gap">${gap}</div></div>`;
  }).join('');
}

function place(t) {
  const k = EVENTS[$('event').value].k;
  raceTimes().forEach(({ p, t: rt }) => {
    if (rt == null) return;
    const progress = Math.min(1, (t / rt) ** k);
    $('car-' + p.series).style.setProperty('--p', progress);
    $('tag-' + p.series).textContent = progress >= 1 ? secs(rt) : '';
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

/* ---------- colours & options ---------- */
function renderCfg() {
  const p = picks.find(x => x.car.id === cfgKey) || picks[0];
  cfgKey = p.car.id;
  const c = p.car, official = !!c.colours;
  const chooser = picks.length > 1 ? `<label class="field"><span>Car</span><select id="cfg-car">${picks.map(x =>
    `<option value="${esc(x.car.id)}" ${x === p ? 'selected' : ''}>${esc(name(x.car))} · ${esc(x.car.trim)}</option>`).join('')}</select></label>` : '';
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
const range = c => c.range ? c.range
  : c.tank && c.mpg && !['Electric', 'Plug-in hybrid'].includes(c.fuel) ? Math.round(c.tank / 4.546 * c.mpg) : null;
const dim = k => c => approx(c, 'dims', fmt(c.dims?.[k], ' mm'));
const num = (k, unit, dp) => c => approx(c, k, fmt(c[k], unit, dp));

// [label, render, value for "best", 'max' | 'min']. A row whose cells are all "—" is not shown.
const SPEC = [
  ['Performance'],
  ['Power', num('hp', ' hp'), c => c.hp, 'max'],
  ['Torque', num('nm', ' Nm'), c => c.nm, 'max'],
  ['Power-to-weight', c => approx(c, 'kg', fmt(hpPerTonne(c), ' hp/t')), hpPerTonne, 'max'],
  ['0–60 mph', num('z60', ' s', 1), c => c.z60, 'min'],
  ['Top speed', num('top', ' mph'), c => c.top, 'max'],
  ['Engine'],
  ['Fuel', c => esc(c.fuel ?? DASH)],
  ['Engine', c => esc(c.engine ?? DASH)],
  ['Engine size', c => fmt(c.cc, ' cc')],
  ['Drive', c => esc(c.drive ?? DASH)],
  ['Gearbox', c => esc(c.box ?? DASH)],
  ['Running costs'],
  ['Economy', c => c.fuel === 'Electric' ? DASH : fmt(c.mpg, ' mpg'), c => c.fuel === 'Electric' ? null : c.mpg, 'max'],
  ['CO2', c => fmt(c.co2, ' g/km'), c => c.co2, 'min'],
  ['UK car tax', taxCell],
  ['Fuel tank', c => approx(c, 'tank', fmt(c.tank, ' L'))],
  ['Range', c => fmt(range(c), ' miles'), range, 'max'],
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
    const vals = value ? picks.map(p => value(p.car)) : [];
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
  renderRace();
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
$('add').addEventListener('click', addSelected);
$('tray').addEventListener('click', e => {
  const id = e.target.closest('[data-remove]')?.dataset.remove;
  if (id) {
    picks = picks.filter(p => p.car.id !== id);
    renderAll();
  } else if (e.target.closest('#add-slot')) {
    $('finder').scrollIntoView();
    document.querySelector('#fields select:not(:disabled)')?.focus({ preventScroll: true });
  }
});
$('clear').addEventListener('click', () => { picks = []; renderAll(); });
$('share').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    setStatus('', 'Link copied.');
  } catch {
    setStatus('', 'Copy the address bar to share.');
  }
});
// A share link pasted into an open tab only changes the hash. saveHash uses replaceState, which never fires this.
addEventListener('hashchange', () => { picks = []; restoreHash(); });

$('event').innerHTML = Object.entries(EVENTS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
$('env').innerHTML = Object.entries(ENVS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
$('event').addEventListener('change', renderRace);
$('env').addEventListener('change', renderRace);
$('go').addEventListener('click', start);

$('cfg').addEventListener('change', e => {
  if (e.target.id === 'cfg-car') { cfgKey = e.target.value; return renderCfg(); }
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
  renderSpec();
});

/* ---------- start ---------- */
Promise.all([
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
