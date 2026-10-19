"""Build data/cars.db from the open autoevolution scrape (github.com/ilyasozkurt/automobile-models-and-specs).

  python3 tools/build_db.py                 # downloads the dataset (~25 MB) to a temp folder, then builds
  python3 tools/build_db.py --src DIR       # use already-unzipped brands.csv / automobiles.csv / engines.csv

The downloaded files are untrusted: every field is parsed into plain numbers or cleaned text here,
and only autoevolution CDN photo URLs are kept.
"""
import argparse
import csv
import html
import json
import re
import sqlite3
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

URL = "https://raw.githubusercontent.com/ilyasozkurt/automobile-models-and-specs/master/automobiles.csv.zip"
OUT = Path(__file__).resolve().parent.parent / "data" / "cars.db"
IMG_RE = re.compile(r"^https://s1\.cdn\.autoevolution\.com/images/[\w/.-]{1,200}\.jpe?g$")
TAG_RE = re.compile(r"<[^>]*>")
UPPER_OK = {"AC", "BMW", "MG", "GMC", "KTM", "TVR", "NIO", "DS", "ARO", "FSO", "RAM", "GTA", "DR", "SEAT", "MINI", "AMG"}
SPECIAL = {"MERCEDES BENZ": "Mercedes-Benz", "ROLLS-ROYCE": "Rolls-Royce", "MARUTI SUZUKI": "Maruti Suzuki", "DeLorean": "DeLorean"}
FUELS = {"Gasoline": "Petrol", "Diesel": "Diesel", "Electric": "Electric", "Hybrid": "Hybrid", "Hybrid Gasoline": "Hybrid",
         "Hybrid Diesel": "Hybrid", "Mild Hybrid": "Mild hybrid", "Mild Hybrid Diesel": "Mild hybrid",
         "Plug-In Hybrid": "Plug-in hybrid", "Natural Gas": "Natural gas", "Ethanol": "Ethanol",
         "Liquefied Petroleum Gas (Lpg)": "LPG"}
DRIVES = {"Front Wheel Drive": "FWD", "Rear Wheel Drive": "RWD", "All Wheel Drive": "AWD"}


def clean(s, n=120):
    return re.sub(r"\s+", " ", TAG_RE.sub("", html.unescape(s or ""))).strip()[:n]


def brand_name(raw):
    if raw in SPECIAL:
        return SPECIAL[raw]
    return " ".join(w if w in UPPER_OK or not w.isupper() else w.capitalize() for w in raw.split())


def first(pattern, text, cast=float):
    m = re.search(pattern, text or "", re.I)
    if not m:
        return None
    try:
        v = cast(m.group(1).replace(",", ""))
    except ValueError:
        return None
    return v if v > 0 else None


def body_of(name, height):
    n = name.lower()
    if re.search(r"cabrio|convertible|roadster|spyder|spider|volante|targa|barchetta|speedster", n):
        return "roadster"
    if re.search(r"coupe|coupé|gt\b|gran turismo", n):
        return "coupe"
    if re.search(r"suv|crossover|4x4|pickup|pick-up|van|range rover|defender|wrangler|land cruiser|g-class|x[3-7]\b|q[3578]\b", n) or (height or 0) > 1600:
        return "suv"
    if re.search(r"hatch|estate|wagon|touring|avant|sportback|break|kombi|variant|3-door|5-door|\bmini\b|golf|polo|fiesta|corsa|clio", n):
        return "hatch"
    return "sedan"


def parse_engine(specs, name):
    """Engine specs JSON -> flat dict of numbers (None when missing). Units: hp, Nm, kg, mm, L, mph, UK mpg, g/km."""
    g = lambda sec, key: (specs.get(sec) or {}).get(key, "")
    E = specs.get("Engine Specs") or {}
    fuel = FUELS.get(E.get("Fuel:", ""), "Petrol")
    power = E.get("Power:") or E.get("Total Maximum Power:") or E.get("Electrical Motor Power:")
    torque = E.get("Torque:") or E.get("Total Maximum Torque:") or E.get("Electrical Motor Torque:")
    system = (E.get("Fuel System:", "") + " " + name).lower()
    l100 = first(r"([\d.]+)\s*L/100", g("Fuel Economy (Wltp)", "Combined:") or g("Fuel Economy (Nedc)", "Combined:"))
    z62 = first(r"([\d.]+)\s*S", g("Performance Specs", "Acceleration 0-62 Mph (0-100 Kph):"))
    rng = g("Power System Specs", "Range:")
    cc = first(r"([\d,]+)\s*Cm3", E.get("Displacement:"), int)
    asp = "electric" if fuel == "Electric" else "turbo" if ("turbo" in system or "supercharg" in system) else "na"
    cyl = re.sub(r"^L(\d+)$", r"\1-cyl", clean(E.get("Cylinders:", ""), 12))  # "L4" -> "4-cyl"; V6, W12, B4 stay
    engine = "Electric motor" if fuel == "Electric" else \
        clean(f"{f'{cc / 1000:.1f}L' if cc else ''} {cyl}{' turbo' if asp == 'turbo' else ''}")
    return {
        "fuel": fuel,
        "engine": engine.strip() or None,
        "cc": cc,
        "asp": asp,
        "hp": first(r"([\d.]+)\s*Hp", power, lambda s: round(float(s))),
        "nm": first(r"([\d.]+)\s*Nm", torque, lambda s: round(float(s))),
        "kg": first(r"\((\d[\d,]*)\s*Kg\)", g("Weight Specs", "Unladen Weight:"), int),
        "z60": round(z62 * 0.96, 1) if z62 else None,  # 0-62 mph -> approx 0-60 mph
        "top": first(r"(\d+)\s*Mph", g("Performance Specs", "Top Speed:"), int),
        "mpg": round(282.481 / l100) if l100 and fuel != "Electric" else None,
        "co2": 0 if fuel == "Electric" else first(r"(\d+)\s*G/Km", g("Fuel Economy (Wltp)", "Co2 Emissions (Combined):") or g("Fuel Economy (Nedc)", "Co2 Emissions:"), int),
        "tank": first(r"\(([\d.]+)\s*L\)", E.get("Fuel Capacity:"), lambda s: round(float(s))),
        "drive": DRIVES.get(g("Transmission Specs", "Drive Type:"), None),
        "box": clean(g("Transmission Specs", "Gearbox:"), 60) or None,
        "length": first(r"\((\d[\d,]*)\s*Mm\)", g("Dimensions", "Length:"), int),
        "width": first(r"\((\d[\d,]*)\s*Mm\)", g("Dimensions", "Width:"), int),
        "height": first(r"\((\d[\d,]*)\s*Mm\)", g("Dimensions", "Height:"), int),
        "wheelbase": first(r"\((\d[\d,]*)\s*Mm\)", g("Dimensions", "Wheelbase:"), int),
        "clearance": first(r"\((\d[\d,]*)\s*Mm\)", g("Dimensions", "Ground Clearance:"), int),
        "cargo": first(r"\((\d[\d,]*)\s*L\)", g("Dimensions", "Cargo Volume:"), int),
        "range": first(r"([\d.]+)\s*Miles", rng, lambda s: round(float(s))) or
                 (round(first(r"([\d.]+)\s*Km", rng) / 1.609) if first(r"([\d.]+)\s*Km", rng) else None),
        "batt": first(r"([\d.]+)\s*kWh", g("Power System Specs", "Nominal Capacity:") or g("Power System Specs", "Power Pack:")),
    }


def sane(e):
    """Drop values that are clearly scrape errors rather than storing nonsense."""
    limits = {"hp": (5, 2100), "nm": (20, 3000), "kg": (300, 4500), "z60": (1.8, 60), "top": (30, 320), "mpg": (5, 200),
              "co2": (0, 700), "tank": (10, 200), "length": (2000, 7000), "width": (1100, 2600), "height": (900, 2600),
              "wheelbase": (1500, 4500), "cc": (300, 9000)}
    for k, (lo, hi) in limits.items():
        if e.get(k) is not None and not lo <= e[k] <= hi:
            e[k] = None
    if e["wheelbase"] and e["length"] and e["wheelbase"] >= e["length"]:
        e["wheelbase"] = None
    return e


def years_of(title, slug=""):
    m = re.search(r"(\d{4})\s*-\s*(\d{4}|Present)", title, re.I)
    if m:
        return int(m.group(1)), (None if m.group(2).lower() == "present" else int(m.group(2)))
    m = re.match(r"\s*(\d{4})\s", title) or re.search(r"-((?:18|19|20)\d\d)$", slug)  # the URL slug always ends in a year
    return (int(m.group(1)), int(m.group(1))) if m else (None, None)


def build(src, out):
    csv.field_size_limit(10 ** 8)
    read = lambda f: csv.DictReader(open(src / f, encoding="utf-8", errors="replace", newline=""))
    brands = sorted(((re.sub(r"^https://www\.autoevolution\.com/|/$", "", b["url"]), b["name"]) for b in read("brands.csv")),
                    key=lambda x: -len(x[0]))  # longest slug first: "mercedes-amg" before "mercedes"
    out.parent.mkdir(exist_ok=True)
    tmp = out.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    db = sqlite3.connect(tmp)
    db.executescript("""
      CREATE TABLE models (id INTEGER PRIMARY KEY, brand TEXT NOT NULL, name TEXT NOT NULL, year_from INT, year_to INT, image TEXT);
      CREATE TABLE engines (id INTEGER PRIMARY KEY, model_id INT NOT NULL REFERENCES models(id), name TEXT NOT NULL, fuel TEXT,
        engine TEXT, cc INT, asp TEXT, hp INT, nm INT, kg INT, z60 REAL, top INT, mpg INT, co2 INT, tank INT, drive TEXT, box TEXT,
        length INT, width INT, height INT, wheelbase INT, clearance INT, cargo INT, range INT, batt REAL, body TEXT);
    """)
    # automobiles.csv columns are shifted by one in the source: url is in "name", title in "image", photos in "engine_name"
    models = {}
    for a in read("automobiles.csv"):
        url, title = a["name"], clean(a["image"].replace("Photos, engines &amp; full specs", "").replace("Photos, engines & full specs", ""))
        slug = re.sub(r"^https://www\.autoevolution\.com/cars/|\.html$", "", url)
        brand = next((name for s, name in brands if slug.startswith(s + "-")), None)
        if not brand or not a["id"].isdigit():
            continue
        y0, y1 = years_of(title, slug)
        name = re.sub(r"\d{4}\s*-\s*(\d{4}|Present)", "", title, flags=re.I)
        name = re.sub(r"^\s*\d{4,5}\s+", "", name)  # one source title has a typo'd "22025"
        name = re.sub(r"^" + re.escape(brand.replace("-", " ")) + r"\s+|^" + re.escape(brand) + r"\s+", "", name, flags=re.I).strip()
        try:
            photos = [p for p in json.loads(a["engine_name"] or "[]") if isinstance(p, str) and IMG_RE.match(p)]
        except ValueError:
            photos = []
        models[a["id"]] = (int(a["id"]), brand_name(brand), name or title, y0, y1, photos[0] if photos else None)
    db.executemany("INSERT INTO models VALUES (?,?,?,?,?,?)", models.values())

    rows = []
    for e in read("engines.csv"):
        m = models.get(e["automobile_id"])
        if not m or not e["id"].isdigit():
            continue
        try:
            spec = sane(parse_engine(json.loads(e["specs"]), e["name"]))
        except (ValueError, AttributeError, TypeError):
            continue
        spec["body"] = body_of(m[2], spec["height"])
        rows.append((int(e["id"]), m[0], clean(e["name"]), *spec.values()))
    cols = 3 + len(spec)
    db.executemany(f"INSERT INTO engines VALUES ({','.join('?' * cols)})", rows)
    db.executescript("""
      DELETE FROM models WHERE id NOT IN (SELECT model_id FROM engines);
      CREATE INDEX models_brand ON models(brand, year_from);
      CREATE INDEX engines_model ON engines(model_id);
      CREATE INDEX engines_fuel ON engines(fuel);
      ANALYZE;
    """)
    db.commit()
    counts = db.execute("SELECT (SELECT COUNT(DISTINCT brand) FROM models), (SELECT COUNT(*) FROM models), (SELECT COUNT(*) FROM engines)").fetchone()
    db.execute("VACUUM")
    db.close()
    tmp.replace(out)
    print(f"Built {out}: {counts[0]} brands, {counts[1]} models, {counts[2]} versions")
    return counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, help="folder with the unzipped CSVs")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()
    if args.src:
        return build(args.src, args.out)
    with tempfile.TemporaryDirectory() as d:
        z = Path(d) / "a.zip"
        print("Downloading dataset…", file=sys.stderr)
        urllib.request.urlretrieve(URL, z)
        with zipfile.ZipFile(z) as zf:
            for n in ("brands.csv", "automobiles.csv", "engines.csv"):  # extract only the expected names, never arbitrary paths
                (Path(d) / n).write_bytes(zf.read(n))
        build(Path(d), args.out)


if __name__ == "__main__":
    main()
