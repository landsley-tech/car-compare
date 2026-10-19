# Third-party notices

Car Compare is MIT-licensed (see `LICENSE`). It uses or connects to the third-party material below, each under its own terms.

## Icons: Lucide (ISC) and Feather (MIT)

The inline SVG icons in `web/index.html`, `web/app.js` and `web/icon.svg` (gauge, sun, moon, link, plus, x, car) are taken from [Lucide](https://lucide.dev). Some Lucide icons are derived from [Feather](https://feathericons.com).

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

```
The MIT License (MIT) (for the Lucide icons derived from Feather)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Fonts: Fira Sans, Fira Code, Syncopate (SIL Open Font License 1.1)

The fonts are loaded from Google Fonts when the page opens. They are not included in this repository. All three are licensed under the [SIL Open Font License 1.1](https://openfontlicense.org).

## Data

| Source | Used for | Terms |
|---|---|---|
| US EPA, [fueleconomy.gov](https://www.fueleconomy.gov) web services | "US register" tab, fetched live | US government work, public domain |
| [autoevolution.com](https://www.autoevolution.com), via the community scrape [ilyasozkurt/automobile-models-and-specs](https://github.com/ilyasozkurt/automobile-models-and-specs) | "Full database" tab and car photos | **No licence is given.** The data and photos belong to autoevolution. They are **not included** in this repository: `tools/build_db.py` downloads them on your own machine, and photos load directly from autoevolution's servers. Check autoevolution's terms before using them anywhere public. |
| Featured catalogue (`web/data/cars.json`) | "Featured" tab | Part of this project, MIT-licensed. The figures are approximate, compiled from commonly published specifications. |

Car makes and model names are trademarks of their owners. They are used here only to identify the vehicles, and this project is not affiliated with or endorsed by any manufacturer.

## Development tools (not distributed)

The end-to-end tests drive a locally installed headless Chrome (from Playwright's browser cache). No browser or test tool is bundled with this project.
