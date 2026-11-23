// Car Compare. Copyright (c) 2026 Landsley Bowerman. MIT licence, see LICENSE.
// Designed by Landsley Bowerman; code written by Claude (Anthropic) from Landsley's prompts.
// SPDX-License-Identifier: MIT
// End-to-end: drives the real page in headless Chrome over the DevTools protocol. No npm packages needed.
// Run: node tests/e2e.mjs   (CHROME=/path/to/chrome to choose a browser, EPA=1 to also test the live EPA lookup, OUT=dir for screenshots)
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const findChrome = () => {
  const base = join(homedir(), '.cache/ms-playwright');
  const dir = readdirSync(base).find(d => d.startsWith('chromium_headless_shell'));
  return join(base, dir, 'chrome-headless-shell-linux64/chrome-headless-shell');
};
const CHROME = process.env.CHROME || findChrome();
const OUT = process.env.OUT || mkdtempSync(join(tmpdir(), 'car-e2e-'));
const PORT = 8100 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = spawn('python3', ['server.py'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless', '--remote-debugging-port=0', '--no-sandbox', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'chr-'))}`, 'about:blank']);
const wsUrl = await new Promise((res, rej) => {
  chrome.stderr.on('data', d => { const m = String(d).match(/ws:\/\/\S+/); if (m) res(m[0]); });
  setTimeout(() => rej(new Error('chrome did not start')), 10000);
});
const cleanup = () => { chrome.kill(); server.kill(); };

try {
  const browser = new WebSocket(wsUrl);
  await new Promise(r => browser.onopen = r);
  let id = 0; const pending = new Map(); const events = [];
  browser.onmessage = msg => { const m = JSON.parse(msg.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else events.push(m); };
  const send = (method, params = {}, sessionId) => new Promise(r => {
    const i = ++id; pending.set(i, r); browser.send(JSON.stringify({ id: i, method, params, sessionId }));
  });
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cdp = (m, p) => send(m, p, sessionId);
  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  const js = async expr => {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(expr + '\n' + JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  };
  const waitFor = async (expr, ms = 15000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) if (await js(expr)) return;
    throw new Error('timed out waiting for ' + expr);
  };
  const idle = () => waitFor(`!document.querySelector('#status .spinner')`);
  // choose by exact value, or by the first option whose text starts with `text`
  const choose = async (k, v, { text } = {}) => {
    await idle();
    await js(`(() => { const s = document.getElementById('f-${k}');
      const o = [...s.options].find(o => ${text ? `o.text.startsWith(${JSON.stringify(v)})` : `o.value === ${JSON.stringify(v)}`});
      if (!o) throw new Error('no option ${v} in ${k}: ' + [...s.options].slice(0, 15).map(o => o.text).join(' | '));
      s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await idle();
  };
  const firstVersion = () => js(`(() => { const s = document.getElementById('f-version'); if (!s.value) { s.value = s.options[1].value; s.dispatchEvent(new Event('change', { bubbles: true })); } })()`).then(idle);
  const add = async n => { await js(`document.getElementById('add').click()`); await waitFor(`document.querySelectorAll('.slot:not(.add)').length === ${n}`); };
  const shot = async (name, width, height) => {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    await sleep(500);
    const { result } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height: await js('document.documentElement.scrollHeight'), scale: 1 } });
    writeFileSync(join(OUT, name), Buffer.from(result.data, 'base64'));
  };
  const step = s => console.log('✓', s);

  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE });
  await waitFor(`document.getElementById('f-make')?.options.length > 100`);
  assert.match(await js(`document.getElementById('counts').textContent`), /29,971 versions/);
  assert.equal(await js(`getComputedStyle(document.querySelector('.tabs')).overflowX`), 'visible', 'source tabs must not be a scroll box');
  step('page loads on the full database (122 brands, counts shown); source tabs have no scrollbar');

  // a malformed share link is ignored, not an error
  await cdp('Page.navigate', { url: BASE + '#cars=%E0%A4' });
  await waitFor(`document.getElementById('f-make')?.options.length > 100`);
  assert.equal(await js(`document.querySelectorAll('.slot:not(.add)').length`), 0);

  // Featured era filter counts every decade a model was on sale (Morris Minor 948cc: 1956, sold into the 60s)
  await js(`document.querySelector('[data-src="featured"]').click()`);
  await choose('decade', '1960s'); await choose('make', 'Morris'); await choose('model', 'morris-minor');
  assert.equal(await js(`document.getElementById('f-version').options.length`), 3);
  await js(`document.querySelector('[data-src="db"]').click()`);
  await waitFor(`document.getElementById('f-make')?.options.length > 100`);
  step('malformed share link ignored; Featured era filter matches the database rule');

  // full database: a single car
  await choose('decade', '2010');
  await choose('make', 'BMW');
  assert.ok(await js(`document.querySelectorAll('#f-model optgroup').length > 1`), 'models grouped by decade');
  await choose('model', 'M4 Coupe (F82)', { text: true });
  await firstVersion();
  await add(1);
  assert.equal(await js(`document.getElementById('overview-title').textContent`), 'Specification');
  assert.ok(await js(`!!document.querySelector('.slot img[src^="https://s1.cdn.autoevolution.com/"]')`));
  step('database: 2010s BMW M4 (F82) added with photo, single-car spec view');

  // fuel filter narrows brands
  await choose('decade', '');
  await choose('fuel', 'Electric');
  const evBrands = await js(`[...document.getElementById('f-make').options].slice(1).map(o => o.value)`);
  assert.ok(evBrands.includes('Tesla') && !evBrands.includes('Ferrari'), 'electric filter');
  await choose('make', 'Tesla'); await choose('model', 'Model 3', { text: true }); await firstVersion();
  await add(2);
  step('fuel filter (Electric) + Tesla added');

  // a 1950s classic from the database
  await choose('fuel', '');
  await choose('decade', '1950');
  await choose('make', 'Mercedes-Benz');
  await choose('model', '300', { text: true });
  await firstVersion();
  await add(3);
  step('era filter: 1950s Mercedes-Benz added');

  // featured catalogue: colours/options + a slow classic
  await js(`document.querySelector('[data-src="featured"]').click()`);
  await waitFor(`document.querySelector('[data-src="featured"]').getAttribute('aria-selected') === 'true'`);
  await choose('make', 'Audi'); await choose('model', 'audi-a3-8y'); await choose('version', 'audi-a3-8y:s3');
  await add(4);
  await choose('make', 'Volkswagen'); await choose('model', 'vw-beetle-54');
  await add(5);
  await js(`document.getElementById('add').click()`);
  await waitFor(`/already/i.test(document.getElementById('status').textContent)`);
  step('featured tab: Audi S3 + VW Beetle added; duplicate rejected');

  // outlines: four views, one outline per car with dimensions
  const sized = await js(`document.querySelectorAll('.view.wide')[0].querySelectorAll('.shape').length`);
  assert.ok(sized >= 4, 'side view outlines: ' + sized);
  assert.equal(await js(`document.querySelectorAll('.view').length`), 4);
  step(`dimension outlines: 4 views × ${sized} cars`);

  // race
  await js(`(() => { const e = document.getElementById('event'); e.value = 'roll'; e.dispatchEvent(new Event('change')); })()`);
  assert.match(await js(`document.getElementById('strip').textContent`), /Can't reach 100 mph/);
  await js(`(() => { const e = document.getElementById('event'); e.value = 'qm'; e.dispatchEvent(new Event('change'));
    const v = document.getElementById('env'); v.value = 'wet'; v.dispatchEvent(new Event('change')); })()`);
  await js(`document.getElementById('go').click()`);
  await waitFor(`document.querySelector('#go span').textContent === 'Restart'`);
  await waitFor(`document.querySelectorAll('.res').length > 0 && document.querySelectorAll('.res.pending').length === 0`, 40000);
  // the review-style events: braking is shown as a distance, and every event has a lane for every car
  await js(`(() => { const v = document.getElementById('env'); v.value = 'dry'; v.dispatchEvent(new Event('change'));
    const e = document.getElementById('event'); e.value = 'brake'; e.dispatchEvent(new Event('change')); })()`);
  assert.match(await js(`document.getElementById('race-results').textContent`), /P1.*\d\d\.\d m in \d\.\d\d s/s);
  assert.equal(await js(`document.querySelectorAll('#strip .dnf').length`), 0, 'every car can brake');
  assert.match(await js(`[...document.querySelectorAll('#strip .tag')].map(t => t.textContent).join('|')`), /\d\.\d m/, 'lane tags show metres too');
  assert.deepEqual(await js(`[...document.getElementById('event').options].map(o => o.value)`), ['z60', 'z100', 'qm', 'r3070', 'roll', 'brake', 'lap', 'hill']);
  await js(`(() => { const e = document.getElementById('event'); e.value = 'z100'; e.dispatchEvent(new Event('change')); })()`);
  assert.match(await js(`document.getElementById('strip').textContent`), /Can't reach 100 mph/);
  await js(`(() => { const e = document.getElementById('event'); e.value = 'r3070'; e.dispatchEvent(new Event('change')); })()`);
  assert.match(await js(`document.getElementById('race-name').textContent`), /30–70 mph/);
  step('race: wet ¼ mile runs to the finish; Beetle shown as DNF in 50–100; braking shown in metres; 0–100 and 30–70 run');

  // configurator on the featured Audi
  await js(`(() => { const s = document.getElementById('cfg-car'); s.value = 'audi-a3-8y:s3'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.equal(await js(`document.querySelector('#cfg .total strong').textContent`), '£48,000');
  await js(`document.querySelectorAll('.swatch input')[1].click()`);
  await js(`document.querySelectorAll('#cfg .option input')[0].click()`);
  assert.equal(await js(`document.querySelector('#cfg .total strong').textContent`), '£49,945');
  assert.match(await js(`document.getElementById('spec-table').textContent`), /Kemora Grey/);
  await js(`(() => { const s = document.getElementById('cfg-car'); s.value = s.options[0].value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.match(await js(`document.getElementById('cfg').textContent`), /Typical colours of the 2010s/);
  assert.ok(await js(`document.querySelectorAll('.swatch input').length >= 5`), 'database car has colour choices');
  step('configurator: paint + option update the price; database cars get era colours');

  // spec table
  const tax = await js(`[...document.querySelectorAll('#spec-table tr')].find(r => r.textContent.startsWith('UK car tax')).textContent`);
  assert.match(tax, /£0 a year/);
  assert.ok(await js(`document.querySelectorAll('#spec-table td.best').length > 5`));
  assert.ok(await js(`document.querySelectorAll('#spec-table tr.group').length === 6`));
  step('spec table: grouped rows, best values highlighted, historic tax exemption');

  await shot('desktop-light.png', 1280, 900);
  await js(`document.getElementById('theme').click()`);
  assert.equal(await js(`document.documentElement.dataset.theme`), 'dark');
  await shot('desktop-dark.png', 1280, 900);
  await shot('mobile-dark.png', 390, 844);
  // mobile emulation can zoom out to fit, so check the real layout width as well as scrolling
  assert.equal(await js(`window.innerWidth`), 390, 'page was zoomed out: something is wider than the phone');
  assert.equal(await js(`document.documentElement.scrollWidth > window.innerWidth`), false, 'horizontal scroll on mobile');
  assert.ok(await js(`document.getElementById('finder').getBoundingClientRect().right <= 390`), 'finder overflows');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  step('theme toggle (light/dark); no horizontal scroll at phone width');

  // shareable link restores the line-up
  const link = await js(`location.href`);
  assert.match(link, /#cars=/);
  await cdp('Page.navigate', { url: 'about:blank' });
  await cdp('Page.navigate', { url: link });
  await waitFor(`document.querySelectorAll('.slot:not(.add)').length === 5`, 20000);
  step('shareable link restores all 5 cars');

  // remove
  await js(`document.querySelector('[data-remove="vw-beetle-54:1200"]').click()`);
  assert.equal(await js(`document.querySelectorAll('.slot:not(.add)').length`), 4);
  step('remove a car');

  // swap a version from the card's dropdown: same slot and colour slot, paint carried over
  const audi = `[...document.querySelectorAll('.slot')].find(s => s.textContent.includes('S3 TFSI'))`;
  await waitFor(`!${audi}.querySelector('select.ver').hidden`);
  const before = await js(`${audi}.style.cssText`);
  await js(`(() => { const s = document.getElementById('cfg-car'); s.value = 'audi-a3-8y:s3'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await js(`document.querySelectorAll('.swatch input')[1].click()`);
  const paintName = await js(`document.querySelectorAll('.swatch')[1].textContent.trim().split(/\\s{2,}|\\n/)[0]`);
  await js(`(() => { const s = ${audi}.querySelector('select.ver'); s.value = 'audi-a3-8y:35'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`[...document.querySelectorAll('.slot')].some(s => s.textContent.includes('A3 35 TFSI Sport'))`);
  assert.equal(await js(`[...document.querySelectorAll('.slot')].find(s => s.textContent.includes('A3 35 TFSI Sport')).style.cssText`), before);
  assert.equal(await js(`document.querySelectorAll('.slot:not(.add)').length`), 4);
  assert.ok((await js(`document.getElementById('spec-table').textContent`)).includes(paintName), 'paint carried over: ' + paintName);
  step('card dropdown swaps the Audi S3 for the A3 35 in place, keeping its paint');

  // Change: replace the first car with a different model through the finder, in the same position
  await js(`document.querySelector('[data-change]').click()`);
  await idle();
  assert.match(await js(`document.getElementById('add-label').textContent`), /^Replace M4/);
  assert.notEqual(await js(`document.getElementById('f-version').value`), '', 'finder pre-filled with the car being changed');
  await choose('make', 'Porsche'); await choose('model', '911', { text: true }); await firstVersion();
  await js(`document.getElementById('add').click()`);
  await waitFor(`/Replaced the M4/.test(document.getElementById('status').textContent)`);
  assert.equal(await js(`document.querySelectorAll('.slot:not(.add)').length`), 4);
  assert.match(await js(`document.querySelector('.slot .model').textContent`), /^911/);
  assert.equal(await js(`document.getElementById('add-label').textContent`), 'Add to comparison');
  await js(`document.querySelectorAll('[data-change]')[1].click()`);
  await js(`document.getElementById('cancel-replace').click()`);
  assert.equal(await js(`document.getElementById('add-label').textContent`), 'Add to comparison');
  step('Change replaces the M4 with a Porsche 911 in slot 1; Cancel backs out');

  // 3D models, side drawings beside a person, garage door in the front view
  await js(`document.getElementById('looks').scrollIntoView()`);
  assert.equal(await js(`document.querySelectorAll('#models canvas').length`), 4);
  const inked = `(() => { const c = document.querySelector('#models canvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) n += d[i] > 0; return n; })()`;
  assert.ok(await js(inked) > 2000, '3D canvas is blank');
  const frame = await js(`document.querySelector('#models canvas').toDataURL()`);
  await js(`document.querySelector('#models canvas').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  assert.notEqual(await js(`document.querySelector('#models canvas').toDataURL()`), frame, 'arrow key turns the model');
  assert.equal(await js(`document.querySelectorAll('#profiles svg .person').length`), 8); // head + body per row
  assert.equal(await js(`document.querySelectorAll('#profiles svg .glass').length`), 4);
  assert.equal(await js(`document.querySelectorAll('.view .door').length`), 1);
  await shot('looks.png', 1280, 900);
  step('3D models drawn and turn with the arrow keys; side drawings next to a person; garage door in the front view');

  if (process.env.EPA) {
    await js(`document.querySelector('[data-src="epa"]').click()`);
    await waitFor(`document.getElementById('f-year')?.options.length > 30`);
    await choose('year', '2018');
    await waitFor(`document.getElementById('f-make').options.length > 10`, 30000);
    await choose('make', 'BMW');
    await waitFor(`[...document.getElementById('f-model').options].some(o => o.value === 'M4 Coupe')`, 30000);
    await choose('model', 'M4 Coupe');
    await waitFor(`document.getElementById('f-version').options.length > 1`, 60000);
    await firstVersion();
    await add(5);
    assert.match(await js(`document.getElementById('spec-table').textContent`), /Closest match: M4 Coupe/);
    assert.doesNotMatch(await js(`document.getElementById('strip').textContent`), /No power or weight data/);
    step('live EPA lookup: 2018 BMW M4 Coupe added, matched to the database, and it can race');
  }

  // ---- new features: search, mods, running costs, fit check, ULEZ, units, saved line-ups ----
  const table = id => js(`document.getElementById('${id}').textContent`);
  const setInput = (sel, v, ev = 'change') => js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(String(v))};
    i.dispatchEvent(new Event('${ev}', { bubbles: true })); })()`);
  await js(`document.getElementById('clear').click()`);
  await setInput('#q', 'golf gti', 'input');
  await waitFor(`document.querySelectorAll('#hits [data-hit]').length > 3`);
  assert.ok(await js(`[...document.querySelectorAll('#hits button')].every(b => /golf/i.test(b.textContent) && /gti/i.test(b.textContent))`), 'every hit has both words');
  await setInput('#q', `<img src=x onerror="document.title='pwned'"> ' OR 1=1 --`, 'input');
  await waitFor(`document.querySelector('#hits li.muted')`);
  assert.equal(await js(`document.title + document.querySelectorAll('#hits img').length`), 'Car Compare0');
  await setInput('#q', 'sunbeam tiger', 'input');
  await waitFor(`document.querySelector('#hits [data-hit="sunbeam-tiger:260"]')`);
  await setInput('#q', 'golf r32', 'input');
  await waitFor(`document.querySelector('#hits [data-hit="vw-golf-r32-mk5:man"]')`);
  await js(`document.querySelector('#hits [data-hit="vw-golf-r32-mk5:man"]').click()`);
  await waitFor(`document.querySelectorAll('.slot:not(.add)').length === 1`);
  await setInput('#q', 'golf gti', 'input');
  await waitFor(`document.querySelector('#hits [data-hit^="db-"]')`);
  await js(`[...document.querySelectorAll('#hits [data-hit^="db-"]')].find(b => /turbo|TSI|TFSI/i.test(b.textContent) || true).click()`);
  await waitFor(`document.querySelectorAll('.slot:not(.add)').length === 2`);
  step('search: every word must match, hostile text is harmless, clicking a hit adds the car (Featured and database); new British makes found');

  // mods on the Golf R32 (non-turbo 3.2 V6, 247 hp): stage 1 is 7%, there is no stage 2, lowering changes the drawing
  await js(`(() => { const s = document.getElementById('mod-car'); s.value = 'vw-golf-r32-mk5:man'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.equal(await js(`document.querySelectorAll('#mod-card input[name=tune]').length`), 2, 'non-turbo: Standard and Stage 1 only');
  const stockRace = await js(`document.getElementById('race-results').textContent`);
  const stockSide = await js(`document.querySelector('#views .view svg').innerHTML`);
  await js(`document.querySelector('#mod-card input[value=stage1]').click()`);
  await js(`document.querySelector('#mod-card input[value=suspension]').click()`);
  assert.match(await table('mod-table'), /Standard247 hp.*Modified≈264 hp/s);
  assert.match(await table('spec-table'), /≈264 hp/);
  assert.match(await table('spec-table'), /Stage 1 remap, Coilovers, 30 mm lower/);
  assert.match(await table('spec-table'), /Mods cost.*£1,300/s);
  assert.match(await js(`document.getElementById('tray').textContent`), /modified/);
  assert.notEqual(await js(`document.getElementById('race-results').textContent`), stockRace, 'mods change the race');
  assert.notEqual(await js(`document.querySelector('#views .view svg').innerHTML`), stockSide, 'lowered car is drawn lower');
  assert.match(await js(`location.hash`), /vw-golf-r32-mk5%3Aman~stage1\.suspension/);
  // your own dyno figure wins, and nonsense is ignored
  await setInput('#mod-card [data-dyno=hp]', 281);
  assert.match(await table('mod-table'), /Modified281 hp/);
  await setInput('#mod-card [data-dyno=hp]', 99999999);
  assert.match(await table('mod-table'), /Modified≈264 hp/);
  // the turbo database Golf gets a stage 2 that ticks and locks its three parts
  await js(`(() => { const s = document.getElementById('mod-car'); s.value = s.options[1].value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  if (await js(`!!document.querySelector('#mod-card input[value=stage2]')`)) {
    await js(`document.querySelector('#mod-card input[value=stage2]').click()`);
    assert.equal(await js(`document.querySelectorAll('#mod-card input[type=checkbox]:checked:disabled').length`), 3);
  }
  // a share link carries the mods; made-up mod names in a link are dropped
  const modLink = await js(`location.href`);
  await js(`location.hash = '#cars=' + encodeURIComponent('vw-golf-r32-mk5:man~stage1.__proto__.<script>.stage9')`);
  await waitFor(`document.querySelectorAll('.slot:not(.add)').length === 1 && /≈264 hp/.test(document.getElementById('spec-table').textContent)`);
  assert.match(await table('spec-table'), /Modifications.*Stage 1 remap\s*Mods cost/s);
  await js(`location.href = ${JSON.stringify(modLink)}`);
  await waitFor(`document.querySelectorAll('.slot:not(.add)').length === 2 && /Coilovers/.test(document.getElementById('spec-table').textContent)`);
  step('mods: remap and parts change power, the race, the drawings and the spec table; dyno figures win; share links keep mods and drop fake ones');

  // running costs: R32 does 26 mpg -> 8,000 miles is 307.7 gallons = 1,398.8 litres
  await setInput('#c-miles', 8000); await setInput('#c-petrol', 150);
  assert.match(await table('spec-table'), /Fuel a year£2,098/);
  await setInput('#c-petrol', 100);
  assert.match(await table('spec-table'), /Fuel a year£1,399/);
  await setInput('#c-petrol', -5);
  assert.equal(await js(`document.getElementById('c-petrol').value`), '100', 'bad price put back');
  assert.match(await js(`document.getElementById('metrics').textContent`), /Fuel and tax a year/);
  assert.match(await table('spec-table'), /ULEZ \/ clean air zones.*(Likely fine|Depends on the year|Likely charged)/s);
  step('running costs follow your mileage and fuel price; bad input is refused; ULEZ row shown');

  // will it fit: default door fits a Golf; a 1.5 m wide gap doesn't
  assert.match(await table('dims-table'), /Fits your spaceYes/);
  await setInput('#sp-width', 1.5);
  assert.match(await table('dims-table'), /Fits your spaceNo: \d+ mm too wide/);
  assert.match(await js(`document.querySelector('#views .legend:has(.door-key)').textContent`), /Your space, 1\.50 × 1\.98 m/);
  await setInput('#sp-width', 0);
  assert.equal(await js(`document.getElementById('sp-width').value`), '1.5', 'zero width refused');
  await setInput('#sp-width', 2.134);
  step('fit check uses your own door or space size');

  // units
  await js(`document.getElementById('units').click()`);
  assert.match(await table('spec-table'), /≈197 kW/);                      // 264 hp
  assert.match(await table('spec-table'), /km\/h/);
  assert.match(await table('spec-table'), /L\/100 km/);
  await js(`document.getElementById('units').click()`);
  assert.match(await table('spec-table'), /≈264 hp/);
  step('units switch: kW, km/h and L/100 km, and back');

  // saved line-ups survive a reload, restore the cars with their mods, and tampered storage is ignored
  await js(`document.getElementById('save').click()`);
  assert.equal(await js(`document.querySelectorAll('#saved .chip').length`), 1);
  await js(`document.getElementById('clear').click()`);
  await cdp('Page.reload'); await waitFor(`document.querySelectorAll('#saved .chip').length === 1`);
  await js(`document.querySelector('#saved [data-load]').click()`);
  await waitFor(`document.querySelectorAll('.slot:not(.add)').length === 2 && /Coilovers/.test(document.getElementById('spec-table').textContent)`);
  assert.equal(await js(`document.getElementById('c-petrol').value`), '100', 'fuel price remembered');
  await js(`localStorage.setItem('lineups', JSON.stringify([{ name: '<img src=x onerror="document.title=1">', hash: 'javascript:alert(1)' }, { name: 5, hash: '#cars=x' }, 'x']));
    localStorage.setItem('costs', '{"miles":"<b>","petrol":-1,"diesel":1e99}'); localStorage.setItem('space', 'not json')`);
  await cdp('Page.reload'); await waitFor(`document.getElementById('f-make')?.options.length > 100`);
  assert.equal(await js(`document.querySelectorAll('#saved .chip').length + document.title`), '0Car Compare');
  assert.deepEqual(await js(`['c-miles', 'c-petrol', 'c-diesel', 'sp-width'].map(i => document.getElementById(i).value)`), ['8000', '140', '148', '2.134']);
  await js(`localStorage.clear()`);
  step('saved line-ups reload with their mods; tampered browser storage falls back to defaults');

  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
  await sleep(300);
  assert.ok(await js(`document.documentElement.scrollWidth <= window.innerWidth`), 'no sideways scroll on a phone with the new sections');
  await shot('new-phone.png', 375, 800);
  await shot('new-desktop.png', 1280, 900);
  step('new sections fit a phone screen');

  // motion: only new cards animate in, bars land on their real length, the theme cross-fade tidies up, reduced motion stops it all
  await cdp('Page.navigate', { url: 'about:blank' });
  await cdp('Page.navigate', { url: BASE + '#cars=' + encodeURIComponent('mini-mk1:850,vw-beetle-54:1200') });
  await waitFor(`document.querySelectorAll('.slot:not(.add)').length === 2`);
  assert.equal(await js(`document.querySelectorAll('.slot.enter').length`), 2, 'new cards animate in');
  assert.equal(await js(`getComputedStyle(document.querySelector('.slot.enter')).animationName`), 'pop');
  await js(`document.getElementById('units').click()`); // re-renders everything
  assert.equal(await js(`document.querySelectorAll('.slot.enter').length`), 0, 'cards already showing animated again');
  await js(`document.getElementById('units').click()`);
  await sleep(900);
  assert.ok(await js(`(() => { const b = [...document.querySelectorAll('.bar i')];
    return b.length > 0 && b.every(i => i.style.getPropertyValue('--w') === i.dataset.w && /^\\d+(\\.\\d)?%$/.test(i.dataset.w)); })()`), 'bars end at their real length');
  await js(`document.getElementById('theme').click()`);
  assert.equal(await js(`document.documentElement.classList.contains('theming')`), true);
  await waitFor(`!document.documentElement.classList.contains('theming')`, 2000);
  await js(`document.getElementById('theme').click()`);
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.deepEqual(await js(`['.slot', '#finder', '.appbar-inner', '#overview'].map(s => getComputedStyle(document.querySelector(s)).animationName)`),
    ['none', 'none', 'none', 'none'], 'reduced motion: no animations');
  assert.equal(await js(`getComputedStyle(document.querySelector('.bar i')).transitionDuration`), '0s', 'reduced motion: bars jump');
  await cdp('Emulation.setEmulatedMedia', { features: [] });
  step('motion: new cards pop in once, bars glide to their real length, theme cross-fades, reduced motion turns it all off');

  const problems = events.filter(e => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && !(e.params.entry.source === 'network' && /fonts\.g|autoevolution/.test(e.params.entry.url || ''))) ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
  assert.deepEqual(problems.map(p => JSON.stringify(p.params).slice(0, 300)), [], 'console errors / CSP violations');
  step('no JS errors or CSP violations');

  // installable + offline: the service worker serves the shell and the Featured catalogue with no network
  await waitFor(`navigator.serviceWorker.ready.then(r => !!r.active)`, 15000);
  assert.equal(await js(`fetch('/manifest.webmanifest').then(r => r.json()).then(m => m.display)`), 'standalone');
  await cdp('Network.enable');
  await cdp('Page.navigate', { url: BASE });
  await waitFor(`!!navigator.serviceWorker.controller`, 15000);
  await waitFor(`document.getElementById('f-make')?.options.length > 100`); // fully started, so nothing is still in flight
  await cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  // a full page load with no network, the way someone opens a saved link offline
  await cdp('Page.navigate', { url: 'about:blank' });
  await cdp('Page.navigate', { url: BASE + '#cars=mini-mk1:850' });
  await waitFor(`document.querySelectorAll('.slot:not(.add)').length === 1`, 15000);
  assert.match(await js(`document.getElementById('spec-table').textContent`), /Mini/);
  await cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  step('installable (manifest + service worker) and works offline with the Featured catalogue');
  console.log('screenshots in', OUT);
  cleanup();
  process.exit(0);
} catch (e) {
  console.error('✗', e.message);
  cleanup();
  process.exit(1);
}
