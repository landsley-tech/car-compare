# Car Compare

Compare any car from 1899 to today: about 30,000 versions of 7,167 models from 122 brands, plus every US-market car since 1984. Pick one car for its full spec sheet, or line up 2–6 cars side by side.

- **Find a car** with dropdowns: fuel type, era, brand, model, version/trim.
- **Three data sources** (tabs in the finder)
  - **Full database (1899–2026):** 29,971 versions with power, torque, weight, 0–60, top speed, economy, CO2, tank, dimensions, boot space and a photo. It's built into `data/cars.db` from the open autoevolution dataset (see below). It has no colour, option or price data.
  - **Featured:** a small curated catalogue (`web/data/cars.json`) that adds paint colours, options and launch prices.
  - **US register (1984–today):** a live lookup from the US EPA (fueleconomy.gov). It covers economy and CO2 only, but includes the newest US models.
- **Line-up** of up to 6 cars with photos. **Copy link** shares the exact line-up.
- **Light/dark theme**, remembered per browser.
- **At a glance:** bar charts for power, torque, weight, power-to-weight, 0–60, economy and price.
- **Dimensions to scale:** overlaid line outlines of the side, front, rear and top, plus a table with the differences.
- **Race:** 0–60, ¼ mile, 50–100 mph, circuit lap or mountain pass. Run each one in the dry, wet, snow, high altitude or desert heat, as an animated race. These are estimates (see below).
- **Configure & colours:** pick a paint and options. The price, outlines, UK car tax and spec table all update.
- **Running costs:** UK car tax (VED) on 2025/26 rules, plus fuel tank size and range.
- **Installable app:** in Chrome or Edge, use the install icon in the address bar (on a phone: "Add to Home Screen"). The app shell and Featured cars work offline.

## Run it

Needs Python 3.10+ only. There are no packages to install.

Mac / Linux:

```bash
git clone https://github.com/landsley-tech/car-compare.git   # or unzip the download
cd car-compare
python3 tools/build_db.py     # first time only: downloads the dataset (~25 MB) and builds data/cars.db (~6 MB)
python3 server.py             # then open http://127.0.0.1:8000
```

Windows (PowerShell): the same steps with `py` instead of `python3`, e.g. `py tools\build_db.py` then `py server.py`. If Python isn't installed, get 3.10+ from python.org and tick "Add Python to PATH".

Press Ctrl+C to stop the server. Without the database the app still runs, with the Featured and US register tabs.

Settings come from environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Address to listen on. Use `0.0.0.0` to reach it from other devices on your home network |
| `PORT` | `8000` | Port |
| `RATE_PER_MIN` | `120` | Requests per minute per visitor before they get "429 Too many requests" |
| `MAX_CONN` | `64` | Total simultaneous connections |
| `MAX_CONN_PER_IP` | `16` | Simultaneous connections per visitor |
| `TRUST_PROXY` | off | `cloudflare` or `caddy` when running behind that proxy on the same machine. Forwarded-IP headers are only trusted from 127.0.0.1 |

## Tests

```bash
python3 -m unittest discover tests     # server, database importer + security/attack tests (47)
node --test                            # tax, race model, outlines, escaping, catalogue checks (12)
node tests/e2e.mjs                     # drives the real page in headless Chrome (add EPA=1 for the live EPA test)
```

The e2e test looks for Playwright's headless Chrome in `~/.cache/ms-playwright`. To use a different browser, set `CHROME=/path/to/chrome`.

## Security

The server is built so that one person can't easily take it down or use it to attack anything:

- **Static files** are loaded into memory at startup and served by exact path, so path traversal (`/../server.py`) is impossible.
- **Rate limiting** gives each visitor a token bucket. Forwarded-IP headers are only believed from the local proxy named in `TRUST_PROXY`, and Caddy's are read from the end the visitor can't fake. IPv6 visitors are limited per /64 network (one home), so rotating addresses doesn't help.
- **Connection caps** (total and per IP) plus a 10-second socket timeout drop slowloris-style slow connections.
- **The EPA proxy** only talks to fueleconomy.gov. It validates every parameter against a strict pattern and caches responses for 24 h. It makes at most 4 upstream calls at a time, so your server can't be used to flood the EPA.
- **Methods:** only GET and HEAD are accepted. Long URLs get 414.
- **Errors:** upstream error details are never sent to the browser.
- **Browser hardening:** a strict Content-Security-Policy (scripts from this site only), `nosniff`, no framing (clickjacking) and no referrer.
- **Escaping:** every piece of data is HTML-escaped before it reaches the page.
- **Database:** the car database is opened **read-only**, and every query uses bound parameters with validated input. The tests throw SQL injection at it.
- **Importer:** the downloaded dataset is treated as untrusted. HTML is stripped, impossible numbers are dropped, and only photo URLs on the autoevolution CDN are kept (no `javascript:` or other hosts). The zip is read by fixed file names, so it can't write files elsewhere (zip-slip).

## Adding cars to the catalogue

Edit `web/data/cars.json`. Each model has dimensions, colours and add-ons, plus one entry per trim. Copy an existing entry as a template, then run `node --test`. The data checks will catch missing fields, bad colour codes and impossible numbers. Restart the server afterwards, because files are loaded at startup.

## Updating the full database

Run `python3 tools/build_db.py` again, then restart the server. To build from files you've already downloaded, use `--src DIR`.

## Data and licensing

The code in this repo is yours to use. The **Full database** is not included: `tools/build_db.py` downloads a community scrape of autoevolution.com, and the photos load from autoevolution's servers. That data and those photos belong to autoevolution, so check their terms before using them on a public site. US EPA data is US government work (public domain).

## Accuracy notes

- **Full database:** figures come from autoevolution.com, scraped in October 2024. Some versions share identical specs because of errors in that scrape. 0–60 is converted from 0–62 mph. Body style (used for outlines and race icons) is guessed from the model name and height. Coverage is strongest from the 1990s on. Classic British makes it lacks (Austin-Healey, Triumph, Rover, Morris, Jensen, Hillman, Reliant) are covered by Featured entries instead; Sunbeam, Humber, Riley and Wolseley are still missing.
- **Featured catalogue figures** were compiled by Claude from commonly published and magazine-tested numbers. They have not been checked against official sources, so may be off for your market or spec. Prices are approximate list prices at launch in GBP. To correct anything, edit `web/data/cars.json` and run `node --test`.
- **Race times** use tested 0–60 times where known. Everything else is estimated from power-to-weight, drivetrain, engine type and conditions. Use them for the order and the gaps, not as lap records.
- **UK tax** uses the model year as the registration date and 2025/26 rates. The rate tables in `web/logic.js` need updating each April.
- **EPA data** is US-market. Economy is converted to UK mpg and CO2 to g/km, but it comes from the US test cycle.
