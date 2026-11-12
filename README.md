# Car Compare

© 2026 Landsley Bowerman · MIT licence · Designed by Landsley Bowerman, built with Claude

Compare any car from 1899 to today: about 30,000 versions of 7,167 models from 122 brands, plus every US-market car since 1984. Pick one car for its full spec sheet, or line up 2–6 cars side by side.

- **Find a car** by typing its name ("golf gti") in the search box, or with dropdowns: fuel type, era, brand, model, version/trim.
- **Three data sources** (tabs in the finder)
  - **Full database (1899–2026):** 29,971 versions with power, torque, weight, 0–60, top speed, economy, CO2, tank, dimensions, boot space and a photo. It's built into `data/cars.db` from the open autoevolution dataset (see below). Where the source is missing power, weight or size, the importer estimates them from the version name, sister versions, the car's size or the previous generation; the app marks those values with ≈.
  - **Featured:** a small curated catalogue (`web/data/cars.json`) that adds paint colours, options and launch prices.
  - **US register (1984–today):** a live lookup from the US EPA (fueleconomy.gov), including the newest US models. The EPA has no power, weight or size figures, so the server borrows them from the closest Full-database match (same make, model, years, fuel and engine size) and labels them "Closest match". No confident match means no borrowed numbers.
- **Line-up** of up to 6 cars with photos. **Copy link** shares the exact line-up.
- **Edit the line-up:** each card has a dropdown to swap to another version of the same model, and a **Change** button that loads the car into the finder so you can replace it with any other car in the same place.
- **Save a line-up** in your browser and reload it later (the **Save** button). Saved line-ups stay on that device.
- **Light/dark theme** and **UK or metric units** (hp/mph/mpg or kW/km/h/L per 100 km), remembered per browser.
- **At a glance:** bar charts for power, torque, weight, power-to-weight, 0–60, economy and price.
- **Dimensions to scale:** overlaid line outlines of the side, front, rear and top, plus a table with the differences. The front view also shows a garage door. It starts as a UK single door (2.13 × 1.98 m); type your own door or parking space size and the table says whether each car fits.
- **In 3D:** a model of each car you can turn by dragging or with the arrow keys, all to the same scale and in your chosen colour. Below that, a detailed side-on drawing of each car next to a 1.75 m person. The shapes are typical for the body style (saloon, hatch, SUV…), sized to each car's real length, width, height and wheelbase, so they aren't exact replicas.
- **Race:** 0–60, ¼ mile, 50–100 mph, circuit lap or mountain pass. Run each one in the dry, wet, snow, high altitude or desert heat, as an animated race. These are estimates (see below).
- **Modifications:** pick a Stage 1 or Stage 2 remap and parts (induction kit, exhaust, intercooler, strip-out, lightweight wheels, tyres, coilovers, brakes) for any car. Power, torque, weight, 0–60 and top speed update everywhere, including the race and the drawings (a lowered car is drawn lower), with a rough cost. If the car is already modified, enter your own dyno figures instead. Share links and saved line-ups keep the mods. These are estimates (see below).
- **Colours & options:** Featured cars have factory colours, options and prices; every other car gets the typical colours of its era (labelled as such). The price, outlines, UK car tax and spec table all update.
- **Running costs:** UK car tax (VED) on 2025/26 rules, fuel cost a year from your own mileage and fuel prices, a ULEZ / clean air zone check, plus fuel tank size and range.
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

To run it on an always-on Linux machine (e.g. a home server), run `sudo bash deploy/install.sh` from a clone. It installs the app as a sandboxed systemd service that starts on boot and restarts if it crashes, reachable on your home network and Tailscale at port 8000. Run it again to update.

## Tests

```bash
python3 -m unittest discover tests     # server, database importer + security/attack tests (52)
node --test                            # tax, race model, mods, costs, outlines, 3D model, escaping, catalogue checks (21)
node tests/e2e.mjs                     # 24 steps driving the real page in headless Chrome (add EPA=1 for the live EPA test)
```

To check a running site the way the public reaches it (security headers, HTTPS, blocked attacks, speed, rate limiting):

```bash
python3 tools/check_public.py https://cars.example.com       # your public address
python3 tools/check_public.py http://127.0.0.1:8000           # local
```

Tested on Python 3.10, 3.12 and 3.14 (Linux). The e2e test looks for Playwright's headless Chrome in `~/.cache/ms-playwright`. To use a different browser, set `CHROME=/path/to/chrome`.

## Security

The server is built so that one person can't easily take it down or use it to attack anything:

- **Static files** are loaded into memory at startup and served by exact path, so path traversal (`/../server.py`) is impossible.
- **Rate limiting** gives each visitor a token bucket for the data API. Page files aren't limited (they come from memory), so people sharing one IP (home wifi, offices, mobile networks) can still load the site. Forwarded-IP headers are only believed from the local proxy named in `TRUST_PROXY`, and Caddy's are read from the end the visitor can't fake. IPv6 visitors are limited per /64 network (one home), so rotating addresses doesn't help.
- **Connection caps** (total and per IP) plus a 10-second socket timeout drop slowloris-style slow connections.
- **The EPA proxy** only talks to fueleconomy.gov. It validates every parameter against a strict pattern and caches responses for 24 h. It makes at most 4 upstream calls at a time, so your server can't be used to flood the EPA.
- **Methods:** only GET and HEAD are accepted. Long URLs get 414.
- **Errors:** upstream error details are never sent to the browser.
- **Browser hardening:** a strict Content-Security-Policy (scripts from this site only), `nosniff`, no framing (clickjacking) and no referrer.
- **Escaping:** every piece of data is HTML-escaped before it reaches the page.
- **Database:** the car database is opened **read-only**, and every query uses bound parameters with validated input. The tests throw SQL injection at it.
- **Search:** the search text is checked against the same strict pattern as every other parameter, each word is a bound parameter, and the `_` wildcard is escaped, so a search can't dump the database. Results are capped at 20.
- **Share links and browser storage:** mod names in a link are checked against the built-in list, so made-up ones are dropped. Saved line-ups, fuel prices and space sizes read from browser storage are validated, and anything tampered with falls back to the defaults.
- **Importer:** the downloaded dataset is treated as untrusted. HTML is stripped, impossible numbers are dropped, and only photo URLs on the autoevolution CDN are kept (no `javascript:` or other hosts). The zip is read by fixed file names, so it can't write files elsewhere (zip-slip).

## Adding cars to the catalogue

Edit `web/data/cars.json`. Each model has dimensions, colours and add-ons, plus one entry per trim. Copy an existing entry as a template, then run `node --test`. The data checks will catch missing fields, bad colour codes and impossible numbers. Restart the server afterwards, because files are loaded at startup.

## Changing the modification figures

The remap and parts list is the `MODS` table near the top of the modifications section in `web/logic.js`. Each entry has a label, a rough fitted cost in pounds, and what it changes: `gain` is `[power ×, torque ×]` for turbo petrol (`tp`), turbo diesel (`td`) and non-turbo (`na`) engines, `kg` is a weight change, `launch` and `corner` scale the race times, and `drop` lowers the car in millimetres. Leave an engine type out of `gain` and the part isn't offered for it. Run `node --test` afterwards and restart the server.

## Updating the full database

Run `python3 tools/build_db.py` again, then restart the server. To build from files you've already downloaded, use `--src DIR`.

## Data and licensing

The code in this repo is yours to use. The **Full database** is not included: `tools/build_db.py` downloads a community scrape of autoevolution.com, and the photos load from autoevolution's servers. That data and those photos belong to autoevolution, so check their terms before using them on a public site. US EPA data is US government work (public domain).

## Accuracy notes

- **Full database:** figures come from autoevolution.com, scraped in October 2024. Some versions share identical specs because of errors in that scrape. 0–60 is converted from 0–62 mph. Body style (used for outlines and race icons) is guessed from the model name and height. Coverage is strongest from the 1990s on. Classic British makes it lacks (Austin-Healey, Triumph, Rover, Morris, Jensen, Hillman, Reliant, Sunbeam, Humber, Riley, Wolseley) are covered by Featured entries instead, some with only one model each.
- **Featured catalogue figures** were compiled by Claude from commonly published and magazine-tested numbers. They have not been checked against official sources, so may be off for your market or spec. Prices are approximate list prices at launch in GBP. To correct anything, edit `web/data/cars.json` and run `node --test`.
- **Race times** use tested 0–60 times where known. Everything else is estimated from power-to-weight, drivetrain, engine type and conditions. Use them for the order and the gaps, not as lap records.
- **Modifications** use typical gains for the type of engine (for example about 22% more power from a Stage 1 remap on a turbo petrol, about 7% on a non-turbo), not figures measured on your car. Costs are rough UK prices. Economy, CO2 and tax stay as the standard car's. In the UK you must tell your insurer about modifications.
- **Fuel cost** uses the official mpg, which most cars don't reach in real driving. Plug-in hybrids are left out because their official mpg assumes a full battery. The starting fuel prices are placeholders: type in what you pay.
- **ULEZ check** is a rule of thumb from fuel and year (petrol from 2006, diesel from 2016, electric and 40-year-old cars pass). Check a real car by registration on the TfL or GOV.UK checker.
- **Fits your space** compares body width, which leaves out the mirrors (about 200 mm more).
- **UK tax** uses the model year as the registration date and 2025/26 rates. The rate tables in `web/logic.js` need updating each April.
- **EPA data** is US-market. Economy is converted to UK mpg and CO2 to g/km, but it comes from the US test cycle.

## Release notes

### 12 November 2026

New:

- **Modifications:** choose a Stage 1 or Stage 2 remap and parts (induction kit, exhaust, intercooler, strip-out, lightweight wheels, tyres, coilovers, brakes) for any car. Power, torque, weight, 0–60 and top speed update in the charts, the race and the spec table, with a rough cost. Enter your own dyno figures if the car is already modified. Share links keep the mods.
- **Search:** type a car's name ("golf gti") instead of using the dropdowns.
- **Yearly running cost:** fuel and tax a year from your own mileage and fuel prices.
- **Fits your space:** enter your own garage door or parking space size and see whether each car fits.
- **Saved line-ups:** a Save button keeps line-ups in your browser.
- **ULEZ / clean air zone check** in the spec table.
- **Units switch:** hp, mph and mpg, or kW, km/h and L per 100 km.
- **3D models** of each car that you can turn, to scale and in your chosen colour.
- **Side drawings** of each car next to a 1.75 m person.
- **Garage door** in the front view of the dimension outlines.
- **Edit the line-up:** a version dropdown on each card, and a Change button to replace a car in place.
- **Four more classic British makes** in Featured: Sunbeam Tiger, Humber Super Snipe, Riley Elf, Wolseley 6/110.

Changed:

- Acknowledgements and third-party notices expanded; font list corrected.
- Tests grew to 52 Python, 21 Node and 24 browser steps.

Known issues:

- UK car tax still uses 2025/26 rates.

### 19 October 2026

First release.

- Compare 1 to 6 cars from three sources: the full database (29,971 versions, 1899–2026), the Featured catalogue and the live US EPA register.
- Overview charts, to-scale dimension outlines, race estimates in five conditions, colours and options, UK car tax and a full spec table.
- Light and dark themes, share links, and an installable app that works offline for Featured cars.
- Gaps in the database filled with estimates, marked with ≈.
- Security hardening: rate limits, connection caps, strict input checks and a read-only database.
- Home server installer (`deploy/install.sh`) and a public site checker (`tools/check_public.py`).
- MIT licence, third-party notices and credits.

## Credits

- **Design and direction: Landsley Bowerman.** Landsley planned the app, chose every feature (the car finder and filters, comparing two or more cars, to-scale outlines, running costs and car tax, colours and options, racing in different conditions, security and self-hosting), set the visual direction, and reviewed and tested the results.
- **Code: Claude** (Anthropic's AI model, Claude Opus 5.5, working in Claude Code). Claude wrote the code, tests and documentation from Landsley's prompts.

### Acknowledgements

Car Compare is built on information and tools other people made. Thank you to everyone below.

**Data**

- **[autoevolution.com](https://www.autoevolution.com)** for the specifications and photos in the Full database. They researched and published them, and they still own the data and photos.
- **[İlyas Özkurt](https://github.com/ilyasozkurt)** for [automobile-models-and-specs](https://github.com/ilyasozkurt/automobile-models-and-specs), the scrape of autoevolution that `tools/build_db.py` imports (data last updated 23 October 2024).
- **The US Environmental Protection Agency and Department of Energy** for [fueleconomy.gov](https://www.fueleconomy.gov), the live source of the US register (public domain).
- **GOV.UK** for the [vehicle tax rate tables](https://www.gov.uk/vehicle-tax-rate-tables) behind the UK car tax figures. Contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).
- **The car makers and the motoring press** whose published specifications, road-test figures, paint and option lists and launch prices the Featured catalogue is compiled from. Car names and badges are trademarks of their owners.

**Design**

- **[Lucide](https://lucide.dev)** and **[Feather](https://feathericons.com)** (Cole Bemis) for the icons.
- **Fira Sans** by Erik Spiekermann, Ralph du Carrois and the Carrois Apostrophe team for Mozilla, served by [Google Fonts](https://fonts.google.com).
- **ui-ux-pro-max**, the Claude Code design plugin used to shape the visual style.

**Tools**

- **[Python](https://www.python.org)** and **[SQLite](https://sqlite.org)**, which run the server and the car database with nothing else to install.
- **[Node.js](https://nodejs.org)** for the unit tests, and **[Chromium](https://www.chromium.org)** from **[Playwright](https://playwright.dev)** for the end-to-end browser tests.
- **[Anthropic](https://www.anthropic.com)**, for Claude and Claude Code.

The 3D models, side drawings, outlines, person figure and race graphics are drawn by the app's own code; no 3D library or third-party artwork is used. The garage door uses the common UK size for a single up-and-over door (7 ft × 6 ft 6 in), and the person is 1.75 m, about the UK adult average.

Full terms for each are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Licence

© 2026 Landsley Bowerman. Released under the [MIT licence](LICENSE): anyone may use, change and share this code, as long as they keep the copyright notice.

Third-party icons, fonts and data keep their own terms; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The Full database and car photos are **not** covered by this licence.
