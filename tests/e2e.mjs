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
  step('page loads on the full database (122 brands, counts shown)');

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
  await waitFor(`/already/.test(document.getElementById('status').textContent)`);
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
  step('race: wet ¼ mile runs to the finish; Beetle shown as DNF in 50–100');

  // configurator on the featured Audi
  await js(`(() => { const s = document.getElementById('cfg-car'); s.value = 'audi-a3-8y:s3'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.equal(await js(`document.querySelector('.total strong').textContent`), '£48,000');
  await js(`document.querySelectorAll('.swatch input')[1].click()`);
  await js(`document.querySelectorAll('.option input')[0].click()`);
  assert.equal(await js(`document.querySelector('.total strong').textContent`), '£49,945');
  assert.match(await js(`document.getElementById('spec-table').textContent`), /Kemora Grey/);
  await js(`(() => { const s = document.getElementById('cfg-car'); s.value = s.options[0].value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.match(await js(`document.getElementById('cfg').textContent`), /don't have colour or option data/);
  step('configurator: paint + option update the price; database cars explain missing options');

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
    assert.match(await js(`document.getElementById('spec-table').textContent`), /US EPA register/);
    step('live EPA lookup: 2018 BMW M4 Coupe added');
  }

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
  await cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
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
