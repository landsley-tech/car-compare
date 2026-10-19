import { esc, ukTax, raceTime, EVENTS, ENVS, outline, flatten, unique, configPrice } from './logic.js';

const $ = id => document.getElementById(id);
const MAX_PICKS = 6;
const fmt = (v, unit = '', dp = 0) => v == null || Number.isNaN(v) ? '—' : `${Number(v).toLocaleString('en-GB', { maximumFractionDigits: dp, minimumFractionDigits: dp })}${unit}`;
const gbp = v => v == null ? '—' : '£' + Math.round(v).toLocaleString('en-GB');
const secs = s => s >= 60 ? `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}` : s.toFixed(2);
const decade = y => y ? `${Math.floor(y / 10) * 10}s` : 'Year unknown';
const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
const ICON_X = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const ICON_PLUS = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M12 5v14"/></svg>';

/* ---------- theme (light / dark, remembered per browser) ---------- */
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } },
                set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  $('theme').setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
}
setTheme(store.get('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('theme').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(t); store.set('theme', t);
});

/* ---------- data access ---------- */
const cache = {};
function api(path) {
  if (!cache[path]) cache[path] = fetch('/api/' + path).then(async r => {
    if (!r.ok) { delete cache[path]; throw new Error((await r.json().catch(() => ({}))).error || r.statusText); }
    return r.json();
  });
  return cache[path];
}

let FEATURED = [], meta = null, src = 'db', picks = [], cfgKey = null;
const sel = {};

// Each source lists its dropdowns in order; every dropdown's options may depend on the choices above it.
const SOURCES = {
  db: {
    hint: () => meta ? `${fmt(meta.versions)} versions of ${fmt(meta.models)} models from ${meta.brands} brands, ${meta.from} to today. Full specs and dimensions, but no colour or option data.` : '',
    fields: [
      { k: 'fuel', label: 'Fuel type', any: 'Any fuel', opts: async () => meta.fuels },
      { k: 'decade', label: 'Era', any: 'Any year', opts: async () => meta.decades.map(d => ({ value: String(d), text: d + 's' })) },
      { k: 'make', label: 'Brand', any: 'Choose brand', opts: s => api('db/brands?' + qs({ fuel: s.fuel, decade: s.decade })) },
      { k: 'model', label: 'Model', any: 'Choose model', needs: 'make', opts: async s =>
        (await api('db/models?' + qs({ brand: s.make, fuel: s.fuel, decade: s.decade }))).map(m =>
          ({ value: String(m.id), text: `${m.name} (${m.from ?? '?'}${m.to === m.from ? '' : '–' + (m.to ?? 'now')})`, group: decade(m.from) })) },
      { k: 'version', label: 'Version', any: 'Choose version', needs: 'model', opts: async s =>
        (await api('db/versions?' + qs({ model: s.model, fuel: s.fuel }))).map(v => ({ value: String(v.id), text: `${v.text} · ${v.fuel}` })) },
    ],
    load: s => api('db/car?' + qs({ id: s.version })),
  },
  featured: {
    hint: () => 'A curated catalogue (1954 to today, including British classics), with available colours, options and launch prices.',
    fields: [
      { k: 'fuel', label: 'Fuel type', any: 'Any fuel', opts: async () => unique(FEATURED.map(c => c.fuel)) },
      { k: 'decade', label: 'Era', any: 'Any year', opts: async () => unique(FEATURED.map(c => decade(c.year))) },
      { k: 'make', label: 'Brand', any: 'Choose brand', opts: async s => unique(featuredPool(s).map(c => c.make)) },
      { k: 'model', label: 'Model', any: 'Choose model', needs: 'make', opts: async s =>
        [...new Map(featuredPool(s).filter(c => c.make === s.make).map(c => [c.modelId, { value: c.modelId, text: `${c.model} (${c.gen}, ${c.years[0]}–${c.years[1] ?? 'now'})` }])).values()] },
      { k: 'version', label: 'Version', any: 'Choose version', needs: 'model', opts: async s =>
        featuredPool(s).filter(c => c.modelId === s.model).map(c => ({ value: c.id, text: `${c.trim} · ${c.fuel}` })) },
    ],
    load: async s => FEATURED.find(c => c.id === s.version),
  },
  epa: {
    hint: () => 'Every car sold in the US since 1984, live from the US EPA. Includes 2025–26 models; economy and CO2 only, no power, size or colour data.',
    fields: [
      { k: 'year', label: 'Year', any: 'Choose year', opts: () => api('epa/years') },
      { k: 'make', label: 'Brand', any: 'Choose brand', needs: 'year', opts: s => api('epa/makes?' + qs({ year: s.year })) },
      { k: 'model', label: 'Model', any: 'Choose model', needs: 'make', opts: s => api('epa/models?' + qs({ year: s.year, make: s.make })) },
      { k: 'fuel', label: 'Fuel type', any: 'Any fuel', needs: 'model', opts: async s => unique((await epaOptions(s)).map(o => o.fuel)) },
      { k: 'version', label: 'Version', any: 'Choose version', needs: 'model', opts: async s =>
        (await epaOptions(s)).filter(o => !s.fuel || o.fuel === s.fuel).map(o => ({ value: String(o.id), text: `${o.text} · ${o.fuel}` })) },
    ],
    load: s => api('epa/vehicle?' + qs({ id: s.version })),
  },
};
const featuredPool = s => FEATURED.filter(c => (!s.fuel || c.fuel === s.fuel) && (!s.decade || decade(c.year) === s.decade));
const epaOptions = s => api('epa/options?' + qs({ year: s.year, make: s.make, model: s.model }));

/* ---------- finder ---------- */
function selectHtml(f, opts) {
  const norm = opts.map(o => typeof o === 'object' ? o : { value: String(o), text: String(o) });
  const option = o => `<option value="${esc(o.value)}" ${o.value === sel[f.k] ? 'selected' : ''}>${esc(o.text)}</option>`;
  const groups = norm.some(o => o.group) ? unique(norm.map(o => o.group)) : null;
  const body = groups ? groups.map(g => `<optgroup label="${esc(g)}">${norm.filter(o => o.group === g).map(option).join('')}</optgroup>`).join('')
                      : norm.map(option).join('');
  const blocked = f.needs && !sel[f.needs];
  return `<label class="field"><span>${esc(f.label)}</span><select id="f-${f.k}" data-k="${f.k}" ${norm.length ? '' : 'disabled'}>
    <option value="">${blocked ? '—' : `${esc(f.any)}${norm.length > 1 ? ` (${fmt(norm.length)})` : ''}`}</option>${body}</select></label>`;
}

let renderSeq = 0;
async function renderFinder() {
  const seq = ++renderSeq, s = SOURCES[src];
  setStatus('loading', 'Loading…');
  $('add').disabled = true;
  try {
    let html = '';
    for (const f of s.fields) {
      const opts = f.needs && !sel[f.needs] ? [] : await f.opts(sel);
      if (seq !== renderSeq) return; // a newer change superseded this render
      const values = opts.map(o => typeof o === 'object' ? o.value : String(o));
      if (!values.includes(sel[f.k])) sel[f.k] = f.k === 'version' && values.length === 1 ? values[0] : '';
      html += selectHtml(f, opts);
    }
    $('fields').innerHTML = html;
    $('add').disabled = !sel.version || picks.length >= MAX_PICKS;
    setStatus();
  } catch (e) {
    if (seq === renderSeq) setStatus('error', `Couldn't load the list: ${e.message}`);
  }
}

function setStatus(kind, text = '') {
  $('status').className = 'status' + (kind === 'error' ? ' error' : '');
  $('status').innerHTML = (kind === 'loading' ? '<span class="spinner" aria-hidden="true"></span>' : '') + esc(text);
}

function setSource(s) {
  src = s;
  Object.keys(sel).forEach(k => delete sel[k]);
  document.querySelectorAll('.segmented [role=tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.src === s));
  $('src-hint').textContent = SOURCES[s].hint();
  renderFinder();
}

async function loadCar(id) {
  if (/^db-\d{1,8}$/.test(id)) return api('db/car?' + qs({ id: id.slice(3) }));
  if (/^epa-\d{1,8}$/.test(id)) return api('epa/vehicle?' + qs({ id: id.slice(4) }));
  return FEATURED.find(c => c.id === id);
}

function addCar(car) {
  if (!car) return false;
  if (picks.length >= MAX_PICKS) { setStatus('error', `You can compare up to ${MAX_PICKS} cars.`); return false; }
  if (picks.some(p => p.car.id === car.id)) { setStatus('error', 'That car is already in your line-up.'); return false; }
  const used = picks.map(p => p.series);
  picks.push({ car, series: [1, 2, 3, 4, 5, 6].find(n => !used.includes(n)), colour: car.colours?.[0]?.name ?? null, addons: [] });
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
  $('add').disabled = !sel.version || picks.length >= MAX_PICKS;
}

/* ---------- shareable link: #cars=db-3497,epa-38623,bmw-m4-f82:m4 ---------- */
function saveHash() {
  const ids = picks.map(p => p.car.id).join(',');
  history.replaceState(null, '', ids ? '#cars=' + encodeURIComponent(ids) : location.pathname);
}
async function restoreHash() {
  const m = location.hash.match(/^#cars=([^&]{1,400})$/);
  if (!m) return;
  const ids = decodeURIComponent(m[1]).split(',').slice(0, MAX_PICKS);
  const cars = await Promise.all(ids.map(id => loadCar(id).catch(() => null)));
  cars.forEach(addCar);
  setStatus();
  renderAll();
}

/* ---------- results ---------- */
const name = c => `${c.make} ${c.model}`;
const col = p => `var(--s${p.series})`;
const paint = p => p.car.colours?.find(c => c.name === p.colour)?.hex ?? col(p);
const price = p => p.car.price ? configPrice(p.car, p.colour, p.addons) : null;
const yearsText = c => c.years ? `${c.years[0] ?? '?'}${c.years[1] === c.years[0] ? '' : '–' + (c.years[1] ?? 'now')}` : c.year;

const SHAPES = {
  coupe: 'M2 20 L4 13 L17 11 L26 5 L41 5 L50 11 L60 13 L62 20 Z', roadster: 'M2 20 L4 13 L22 11 L27 7 L30 11 L60 12 L62 20 Z',
  hatch: 'M2 20 L2 9 L9 5 L37 5 L46 11 L60 13 L62 20 Z', sedan: 'M2 20 L3 12 L14 11 L23 5 L40 5 L49 11 L60 13 L62 20 Z',
  suv: 'M2 21 L2 7 L8 3 L39 3 L48 10 L60 11 L62 21 Z',
};
const carSvg = c => `<svg viewBox="0 0 64 26" aria-hidden="true"><path fill="currentColor" d="${SHAPES[c.body] || SHAPES.sedan}"/>
  <circle cx="15" cy="21" r="4.5" fill="#111"/><circle cx="15" cy="21" r="1.8" fill="#bbb"/>
  <circle cx="49" cy="21" r="4.5" fill="#111"/><circle cx="49" cy="21" r="1.8" fill="#bbb"/></svg>`;

function renderTray() {
  const slots = picks.map(p => `<article class="slot" style="--c:${col(p)}">
    <div class="photo">${p.car.image ? `<img src="${esc(p.car.image)}" alt="${esc(name(p.car))}" loading="lazy" referrerpolicy="no-referrer" width="320" height="180">` : carSvg(p.car)}</div>
    <div class="meta"><span class="make">${esc(p.car.make)}</span><span class="model">${esc(p.car.model)}</span>
      <span class="sub" title="${esc(p.car.trim)}">${esc(p.car.trim)} · ${esc(yearsText(p.car))}</span></div>
    <button class="remove" type="button" data-remove="${esc(p.car.id)}" aria-label="Remove ${esc(name(p.car))}">${ICON_X}</button></article>`);
  if (picks.length < MAX_PICKS) slots.push(`<button class="slot add" type="button" id="add-slot"><span>${ICON_PLUS}Add a car</span></button>`);
  $('tray').innerHTML = slots.join('');
  // broken or blocked photos fall back to the silhouette
  $('tray').querySelectorAll('img').forEach(img => img.addEventListener('error', () => {
    const p = picks.find(x => x.car.image === img.getAttribute('src'));
    if (p) img.parentElement.innerHTML = carSvg(p.car);
  }, { once: true }));
  $('tray-count').textContent = `${picks.length} / ${MAX_PICKS}`;
  $('share').disabled = $('clear').disabled = !picks.length;
}

const METRICS = [
  { title: 'Power', hint: 'Horsepower, more is better', get: c => c.hp, unit: ' hp', best: 'max' },
  { title: 'Torque', hint: 'Newton-metres, peak', get: c => c.nm, unit: ' Nm', best: 'max' },
  { title: 'Weight', hint: 'Kerb weight, less is better', get: c => c.kg, unit: ' kg', best: 'min' },
  { title: 'Power-to-weight', hint: 'hp per tonne, the best single guide to pace', get: c => c.hp && c.kg ? Math.round(c.hp / c.kg * 1000) : null, unit: '', best: 'max' },
  { title: '0–60 mph', hint: 'Seconds, shorter is quicker', get: c => c.z60, unit: ' s', best: 'min', dp: 1 },
  { title: 'Economy', hint: 'Combined mpg (UK), more is better', get: c => ['Electric', 'Plug-in hybrid'].includes(c.fuel) ? null : c.mpg, unit: ' mpg', best: 'max' },
  { title: 'Price new', hint: 'As configured, at launch', get: (c, p) => price(p), best: 'min', money: true },
];

function renderMetrics() {
  $('metrics').innerHTML = METRICS.filter(m => picks.some(p => m.get(p.car, p) != null)).map(m => {
    const vals = picks.map(p => m.get(p.car, p)).filter(v => v != null);
    const max = Math.max(...vals), best = m.best === 'max' ? max : Math.min(...vals);
    return `<div class="metric"><h3>${m.title}</h3><p class="help">${m.hint}</p>${picks.map(p => {
      const v = m.get(p.car, p);
      if (v == null) return `<div class="bar-row" style="--c:${col(p)}"><span>${esc(p.car.model)}</span><span class="na">No data</span><span></span></div>`;
      return `<div class="bar-row ${vals.length > 1 && v === best ? 'best' : ''}" style="--c:${col(p)}"><span title="${esc(name(p.car))}">${esc(p.car.model)}</span>
        <span class="bar"><i style="--w:${(v / max * 100).toFixed(1)}%"></i></span><span class="v">${m.money ? gbp(v) : fmt(v, m.unit, m.dp)}</span></div>`;
    }).join('')}</div>`;
  }).join('');
}

const VIEWS = [['side', 'Side'], ['front', 'Front'], ['rear', 'Rear'], ['top', 'Plan (top)']];
const svgShape = s => `<${s.tag} ${Object.entries(s).filter(([k]) => k !== 'tag').map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}/>`;

function renderViews() {
  const sized = picks.filter(p => p.car.dims);
  const missing = picks.filter(p => !p.car.dims).map(p => esc(name(p.car)));
  const legend = `<div class="legend">${sized.map(p => `<span><span class="dot" style="--c:${col(p)}"></span>${esc(p.car.model)}</span>`).join('')}</div>`;
  $('views').innerHTML = !sized.length ? `<p class="help">There's no size data for these cars. US register records don't include dimensions.</p>` : VIEWS.map(([v, label]) => {
    const outs = sized.map(p => ({ p, o: outline(p.car, v) }));
    const W = Math.max(...outs.map(x => x.o.w)), H = Math.max(...outs.map(x => x.o.h)), pad = W * 0.04;
    const body = outs.map(({ p, o }) => {
      const dx = v === 'side' || v === 'top' ? 0 : (W - o.w) / 2, dy = v === 'top' ? (H - o.h) / 2 : H - o.h;
      return `<g class="shape" transform="translate(${dx.toFixed(0)} ${dy.toFixed(0)})" stroke="${col(p)}" fill="${esc(paint(p))}">${o.shapes.map(svgShape).join('')}</g>`;
    }).join('');
    const ground = v === 'top' ? '' : `<line class="ground" x1="${-pad}" y1="${H}" x2="${W + pad}" y2="${H}"/>`;
    return `<figure class="view ${v === 'side' || v === 'top' ? 'wide' : ''}"><h3>${label}</h3>
      <svg viewBox="${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}" role="img" aria-label="${label} outlines of ${sized.map(p => esc(p.car.model)).join(', ')}">${ground}${body}</svg>${legend}</figure>`;
  }).join('') + (missing.length && sized.length ? `<p class="help">No size data for: ${missing.join(', ')}.</p>` : '');

  const rows = [['Length', 'length'], ['Width (no mirrors)', 'width'], ['Height', 'height'], ['Wheelbase', 'wheelbase']];
  const ref = sized[0]?.car.dims;
  $('dims-table').innerHTML = sized.length ? `<thead><tr><th></th>${sized.map(p => `<th style="--c:${col(p)}">${esc(name(p.car))}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(([l, k]) => `<tr><th scope="row">${l}</th>${sized.map((p, i) => {
      const d = p.car.dims[k] - ref[k];
      return `<td>${fmt(p.car.dims[k], ' mm')}${i && d ? ` <span class="diff">${d > 0 ? '+' : ''}${fmt(d)}</span>` : ''}</td>`;
    }).join('')}</tr>`).join('')}</tbody>` : '';
  $('dims-table').parentElement.hidden = !sized.length;
}

/* ---------- race ---------- */
let raf = 0;
const raceTimes = () => picks.map(p => ({ p, t: raceTime(p.car, $('event').value, $('env').value) }));

function renderRace() {
  const ev = $('event').value, env = $('env').value;
  $('board').className = `card board ${env}`;
  $('race-name').textContent = `${EVENTS[ev].label} · ${ENVS[env].label}`;
  $('race-note').textContent = `${EVENTS[ev].note}. ${ENVS[env].note}.`;
  $('strip').innerHTML = raceTimes().map(({ p, t }) => `<div class="lane"><div class="lane-label" title="${esc(name(p.car))}">${esc(p.car.model)}<small>${esc(p.car.year ?? '')}</small></div>
    <div class="track">${t == null ? `<span class="dnf">${p.car.hp && p.car.kg ? "Can't reach 100 mph" : 'Not enough data to race'}</span>` :
      `<div class="car" id="car-${p.series}" style="--c:${col(p)}">${carSvg(p.car)}<span class="tag" id="tag-${p.series}"></span></div>`}</div></div>`).join('');
  rest();
}

function results(t) {
  const done = raceTimes().filter(x => x.t != null).sort((a, b) => a.t - b.t), best = done[0]?.t;
  $('race-results').innerHTML = done.map(({ p, t: rt }, i) => `<div class="res ${rt <= t ? '' : 'pending'}" style="--c:${col(p)}">
    <div class="pos">P${i + 1}</div><div class="name">${esc(p.car.model)}</div><div class="time">${rt <= t ? secs(rt) + ' s' : '—'}</div>
    <div class="gap">${rt <= t ? (i ? '+' + (rt - best).toFixed(2) + ' s' : done.length > 1 ? 'Winner' : 'Solo run') : ''}</div></div>`).join('');
}

function place(t) {
  const k = EVENTS[$('event').value].k;
  raceTimes().forEach(({ p, t: rt }) => {
    if (rt == null) return;
    const prog = Math.min(1, (t / rt) ** k);
    $('car-' + p.series).style.setProperty('--p', prog);
    $('tag-' + p.series).textContent = prog >= 1 ? secs(rt) : '';
  });
  $('clock').textContent = secs(t);
}

function setGo(label) { $('go').querySelector('span').textContent = label; }

function rest() {
  cancelAnimationFrame(raf);
  const done = raceTimes().map(x => x.t).filter(t => t != null);
  const t = done.length ? Math.min(...done) : 0; // resting frame: the winner crossing the line
  place(t); results(t);
  setGo('Start');
}

function start() {
  cancelAnimationFrame(raf);
  const done = raceTimes().map(x => x.t).filter(t => t != null);
  if (!done.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return rest();
  const last = Math.max(...done), scale = last > 16 ? last / 9 : 1; // long races play back in ~9 s
  const t0 = performance.now();
  setGo('Restart');
  const tick = now => {
    const t = Math.min(last, (now - t0) / 1000 * scale);
    place(t); results(t);
    if (t < last) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

/* ---------- configurator ---------- */
function renderCfg() {
  const p = picks.find(x => x.car.id === cfgKey) || picks[0];
  cfgKey = p.car.id;
  const c = p.car;
  const chooser = `<div class="cfg-top">${picks.length > 1 ? `<label class="field"><span>Car to configure</span><select id="cfg-car">${picks.map(x =>
    `<option value="${esc(x.car.id)}" ${x === p ? 'selected' : ''}>${esc(name(x.car))} · ${esc(x.car.trim)}</option>`).join('')}</select></label>` : `<h3>${esc(name(c))} <span class="help">${esc(c.trim)}</span></h3>`}</div>`;
  if (!c.colours) {
    $('cfg').innerHTML = chooser + `<p class="help">We don't have colour or option data for this car. Cars from the <b>Featured</b> tab come with paint colours, options and launch prices.</p>`;
    return;
  }
  $('cfg').innerHTML = `${chooser}<div class="cfg-grid">
    <fieldset><legend>Available colours</legend><div class="swatches">${c.colours.map((k, i) => `<label class="swatch" style="--sw:${esc(k.hex)}">
      <input type="radio" name="paint" value="${i}" ${k.name === p.colour ? 'checked' : ''}><i></i>${esc(k.name)}<span class="na">${k.price ? '+' + gbp(k.price) : 'No cost'}</span></label>`).join('')}</div></fieldset>
    <fieldset><legend>Options &amp; add-ons</legend><div class="options">${c.addons.map((a, i) => `<label class="option"><input type="checkbox" value="${i}" ${p.addons.includes(a.name) ? 'checked' : ''}>
      <span>${esc(a.name)}</span><span class="price">${a.price ? '+' + gbp(a.price) : 'No cost'}</span></label>`).join('')}</div></fieldset>
    <div class="total"><span class="help">As configured</span><strong>${gbp(price(p))}</strong><span class="help">List price at launch, including paint and options</span></div></div>`;
}

/* ---------- full specification ---------- */
function taxCell(c, p) {
  const t = ukTax({ ...c, price: price(p) ?? c.price });
  if (t.annual == null) return `${esc(t.label)}<br><span class="na">${esc(t.note)}</span>`;
  return `${gbp(t.annual)} a year${t.firstYear != null ? `<br><span class="na">First year ${gbp(t.firstYear)}</span>` : ''}<br><span class="na">${esc(t.note)}</span>`;
}
const range = c => c.range ? fmt(c.range, ' miles') : c.tank && c.mpg && !['Electric', 'Plug-in hybrid'].includes(c.fuel) ? fmt(c.tank / 4.546 * c.mpg, ' miles') : null;

// [label, render, numeric value for "best" (optional), 'max' | 'min']
const SPEC = [
  ['Performance'],
  ['Power', c => fmt(c.hp, ' hp'), c => c.hp, 'max'], ['Torque', c => fmt(c.nm, ' Nm'), c => c.nm, 'max'],
  ['Power-to-weight', c => c.hp && c.kg ? fmt(c.hp / c.kg * 1000, ' hp/tonne') : '—', c => c.hp && c.kg ? c.hp / c.kg : null, 'max'],
  ['0–60 mph', c => fmt(c.z60, ' s', 1), c => c.z60, 'min'], ['Top speed', c => fmt(c.top, ' mph'), c => c.top, 'max'],
  ['Engine & drivetrain'],
  ['Fuel', c => esc(c.fuel)], ['Engine', c => esc(c.engine ?? '—')], ['Engine size', c => fmt(c.cc, ' cc')],
  ['Drive', c => esc(c.drive ?? '—')], ['Gearbox', c => esc(c.box ?? '—')],
  ['Running costs'],
  ['Economy', c => c.fuel === 'Electric' ? '—' : fmt(c.mpg, ' mpg'), c => c.fuel === 'Electric' ? null : c.mpg, 'max'],
  ['CO2', c => fmt(c.co2, ' g/km'), c => c.co2, 'min'], ['UK car tax', taxCell],
  ['Fuel tank', c => c.tank ? `${fmt(c.tank, ' L')} <span class="na">(${fmt(c.tank / 4.546, ' gal', 1)})</span>` : '—'],
  ['Range', c => range(c) ?? '—', c => range(c) ? (c.range || c.tank / 4.546 * c.mpg) : null, 'max'],
  ['Battery', c => fmt(c.batt, ' kWh')],
  ['Size & practicality'],
  ['Length', c => fmt(c.dims?.length, ' mm')], ['Width', c => fmt(c.dims?.width, ' mm')], ['Height', c => fmt(c.dims?.height, ' mm')],
  ['Wheelbase', c => fmt(c.dims?.wheelbase, ' mm')], ['Ground clearance', c => fmt(c.clearance, ' mm')],
  ['Boot space', c => fmt(c.cargo, ' L'), c => c.cargo, 'max'], ['Kerb weight', c => fmt(c.kg, ' kg'), c => c.kg, 'min'], ['Body', c => esc(c.body ?? '—')],
  ['Price & spec'],
  ['Price new', c => gbp(c.price), c => c.price, 'min'], ['As configured', (c, p) => gbp(price(p))],
  ['Colour', (c, p) => p.colour ? `<span class="dot" style="--c:${esc(paint(p))}"></span>${esc(p.colour)}` : '—'],
  ['Options fitted', (c, p) => p.addons.length ? p.addons.map(esc).join(', ') : '—'],
  ['About this car'],
  ['Version', c => esc(c.trim)], ['Built', c => esc(yearsText(c) ?? '—')],
  ['Data source', c => ({ db: 'Full database', epa: 'US EPA register' })[c.source] ?? 'Featured catalogue'],
];

function renderSpec() {
  const cols = picks.length + 1;
  $('spec-table').innerHTML = `<thead><tr><th>Spec</th>${picks.map(p => `<th style="--c:${col(p)}" scope="col">${esc(name(p.car))}<small>${esc(p.car.trim)}</small></th>`).join('')}</tr></thead>
    <tbody>${SPEC.map(([label, render, value, better]) => {
      if (!render) return `<tr class="group"><th colspan="${cols}" scope="colgroup">${label}</th></tr>`;
      const vals = value ? picks.map(p => value(p.car)) : [];
      const known = vals.filter(v => v != null);
      const best = known.length > 1 && new Set(known).size > 1 ? (better === 'max' ? Math.max(...known) : Math.min(...known)) : null;
      return `<tr><th scope="row">${label}</th>${picks.map((p, i) => `<td class="${best != null && vals[i] === best ? 'best' : ''}">${render(p.car, p)}</td>`).join('')}</tr>`;
    }).join('')}</tbody>`;
}

function renderAll() {
  const any = picks.length > 0;
  $('results').hidden = !any; $('empty').hidden = any;
  $('overview-title').textContent = picks.length === 1 ? 'Specification' : 'Overview';
  renderTray();
  saveHash();
  $('add').disabled = !sel.version || picks.length >= MAX_PICKS;
  if (!any) return;
  renderMetrics(); renderViews(); renderRace(); renderCfg(); renderSpec();
}

/* ---------- wiring ---------- */
$('fields').addEventListener('change', e => {
  const k = e.target.dataset.k;
  if (!k) return;
  sel[k] = e.target.value;
  renderFinder(); // each render drops downstream choices that are no longer valid
});
document.querySelector('.segmented').addEventListener('click', e => { const b = e.target.closest('[role=tab]'); if (b) setSource(b.dataset.src); });
$('add').addEventListener('click', addSelected);
$('tray').addEventListener('click', e => {
  const id = e.target.closest('[data-remove]')?.dataset.remove;
  if (id) { picks = picks.filter(p => p.car.id !== id); return renderAll(); }
  if (e.target.closest('#add-slot')) { $('finder').scrollIntoView(); document.querySelector('#fields select:not(:disabled)')?.focus({ preventScroll: true }); }
});
$('clear').addEventListener('click', () => { picks = []; renderAll(); });
$('share').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href); setStatus('', 'Link copied. Anyone with it sees this line-up.'); }
  catch { setStatus('', 'Copy this page address to share the line-up.'); }
});
$('event').innerHTML = Object.entries(EVENTS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
$('env').innerHTML = Object.entries(ENVS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
$('event').addEventListener('change', renderRace);
$('env').addEventListener('change', renderRace);
$('go').addEventListener('click', start);
$('cfg').addEventListener('change', e => {
  if (e.target.id === 'cfg-car') { cfgKey = e.target.value; return renderCfg(); }
  const p = picks.find(x => x.car.id === cfgKey);
  if (e.target.name === 'paint') p.colour = p.car.colours[e.target.value].name;
  else if (e.target.type === 'checkbox') {
    const a = p.car.addons[e.target.value].name;
    p.addons = e.target.checked ? [...p.addons, a] : p.addons.filter(x => x !== a);
  }
  renderCfg(); renderMetrics(); renderViews(); renderSpec();
});

Promise.all([
  fetch('/data/cars.json').then(r => r.json()).then(models => { FEATURED = flatten(models); }),
  api('db/meta').then(m => { meta = m; }).catch(() => {}),
]).then(async () => {
  if (meta) $('counts').innerHTML = `<b>${fmt(meta.versions)}</b> versions of <b>${fmt(meta.models)}</b> models from <b>${meta.brands}</b> brands, plus every US-market car since 1984. Full specs, to-scale outlines, UK car tax and race estimates.`;
  setSource(meta ? 'db' : 'featured');
  renderTray();
  await restoreHash();
});

// installable app + offline shell (needs https, or localhost while testing)
if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
